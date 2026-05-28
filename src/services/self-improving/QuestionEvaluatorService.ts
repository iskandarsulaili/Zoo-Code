import type { Logger } from "./types"
import type { ReviewTeamService } from "./ReviewTeamService"

export interface QuestionEvaluationConfig {
	enabled: boolean
	useFullTeam: boolean // use ReviewTeamService when Full Team is enabled
	useContextualAnalysis: boolean // do contextual analysis when Full Auto is enabled
	doResearchBeforeDeciding: boolean // spawn subtask for deeper research
	minChoicesForEvaluation: number // minimum choices to trigger evaluation (default 2)
}

export interface QuestionEvaluation {
	question: string
	choices: { text: string; mode: string | null }[]
	selectedIndex: number
	selectedText: string
	reasoning: string
	evaluatedBy: "full-team" | "contextual" | "research" | "fallback"
}

const DEFAULT_CONFIG: QuestionEvaluationConfig = {
	enabled: true,
	useFullTeam: true,
	useContextualAnalysis: true,
	doResearchBeforeDeciding: false,
	minChoicesForEvaluation: 2,
}

export class QuestionEvaluatorService {
	private logger: Logger
	private config: QuestionEvaluationConfig
	private reviewTeam: ReviewTeamService | null = null

	constructor(logger: Logger, config?: Partial<QuestionEvaluationConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	getConfig(): QuestionEvaluationConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<QuestionEvaluationConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[QuestionEvaluator] Config updated: ${JSON.stringify(updates)}`)
	}

	setReviewTeam(team: ReviewTeamService): void {
		this.reviewTeam = team
	}

	/**
	 * Evaluate all choices and select the best one.
	 * Returns the index of the best choice.
	 */
	async evaluateBestChoice(
		question: string,
		choices: { text: string; mode: string | null }[],
		context?: { taskHistory?: string[]; workspaceFiles?: string[] },
	): Promise<QuestionEvaluation> {
		if (!this.config.enabled || choices.length < this.config.minChoicesForEvaluation) {
			// Fallback: select first choice
			return {
				question,
				choices,
				selectedIndex: 0,
				selectedText: choices[0]?.text ?? "",
				reasoning: "Evaluation disabled or too few choices",
				evaluatedBy: "fallback",
			}
		}

		// Strategy 1: Full Team evaluation (if enabled and ReviewTeamService is available)
		if (this.config.useFullTeam && this.reviewTeam) {
			const evaluation = await this.evaluateWithFullTeam(question, choices, context)
			if (evaluation) return evaluation
		}

		// Strategy 2: Contextual analysis (if enabled)
		if (this.config.useContextualAnalysis) {
			const evaluation = this.evaluateContextually(question, choices, context)
			if (evaluation) return evaluation
		}

		// Strategy 3: Research (if enabled) — would spawn a subtask
		if (this.config.doResearchBeforeDeciding) {
			this.logger.appendLine("[QuestionEvaluator] Research mode enabled but subtask spawning not yet implemented")
		}

		// Final fallback: first choice
		return {
			question,
			choices,
			selectedIndex: 0,
			selectedText: choices[0]?.text ?? "",
			reasoning: "No evaluation strategy produced a result",
			evaluatedBy: "fallback",
		}
	}

	/**
	 * Evaluate choices using the Full Team (ReviewTeamService).
	 * Each persona evaluates each choice and votes.
	 */
	private async evaluateWithFullTeam(
		question: string,
		choices: { text: string; mode: string | null }[],
		context?: { taskHistory?: string[]; workspaceFiles?: string[] },
	): Promise<QuestionEvaluation | null> {
		if (!this.reviewTeam) return null

		this.logger.appendLine(
			`[QuestionEvaluator] Evaluating ${choices.length} choices with Full Team for: "${question.substring(0, 60)}..."`,
		)

		// Score each choice using the review team personas
		const scores: { index: number; score: number; reasoning: string }[] = []

		for (let i = 0; i < choices.length; i++) {
			const choice = choices[i]

			// Create a pseudo-pattern for the review team to evaluate
			const pseudoPattern = {
				id: `question-choice-${i}`,
				patternType: "tool" as const,
				state: "active" as const,
				summary: `Choice ${i + 1}: ${choice.text.substring(0, 100)}`,
				confidenceScore: 0.5,
				frequency: 1,
				successRate: 0.5,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: {
					toolNames: ["ask_followup_question"],
					errorKeys: [],
					modes: choice.mode ? [choice.mode] : [],
				},
			}

			const verdict = await this.reviewTeam.reviewPattern(pseudoPattern)
			scores.push({
				index: i,
				score: verdict.score,
				reasoning: verdict.summary,
			})
		}

		// Sort by score descending, pick the best
		scores.sort((a, b) => b.score - a.score)
		const best = scores[0]

		this.logger.appendLine(
			`[QuestionEvaluator] Full Team selected choice ${best.index + 1} (score: ${(best.score * 100).toFixed(0)}%)`,
		)

		return {
			question,
			choices,
			selectedIndex: best.index,
			selectedText: choices[best.index]?.text ?? "",
			reasoning: best.reasoning,
			evaluatedBy: "full-team",
		}
	}

	/**
	 * Contextual analysis: evaluate choices based on the question context.
	 * Uses heuristics like:
	 * - Prefer choices with mode switches when the question involves delegation
	 * - Prefer specific answers over vague ones
	 * - Prefer answers that match the question's intent
	 */
	private evaluateContextually(
		question: string,
		choices: { text: string; mode: string | null }[],
		context?: { taskHistory?: string[]; workspaceFiles?: string[] },
	): QuestionEvaluation | null {
		const scores = choices.map((choice, index) => {
			let score = 0.5 // neutral start
			const reasons: string[] = []

			// Prefer choices with mode switches when question involves delegation
			if (choice.mode && (question.toLowerCase().includes("mode") || question.toLowerCase().includes("switch"))) {
				score += 0.2
				reasons.push("Mode switch matches delegation intent")
			}

			// Prefer longer, more specific answers
			if (choice.text.length > 50) {
				score += 0.1
				reasons.push("Specific/detailed answer")
			} else if (choice.text.length < 10) {
				score -= 0.1
				reasons.push("Too brief/vague")
			}

			// Prefer answers that contain actionable verbs
			const actionableVerbs = [
				"implement",
				"create",
				"fix",
				"build",
				"write",
				"add",
				"update",
				"refactor",
				"analyze",
				"research",
			]
			if (actionableVerbs.some((v) => choice.text.toLowerCase().includes(v))) {
				score += 0.1
				reasons.push("Actionable answer")
			}

			// Penalize "no" or negative answers when question is asking for action
			if (choice.text.toLowerCase().startsWith("no") || choice.text.toLowerCase().startsWith("don't")) {
				score -= 0.15
				reasons.push("Negative/avoidance answer")
			}

			// Prefer answers that reference the question's key terms
			const questionWords = question
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 4)
			const matchingWords = questionWords.filter((w) => choice.text.toLowerCase().includes(w))
			if (matchingWords.length > 0) {
				score += 0.05 * Math.min(matchingWords.length, 3)
				reasons.push(`Matches ${matchingWords.length} key terms from question`)
			}

			return { index, score, reasoning: reasons.join("; ") || "Neutral evaluation" }
		})

		// Sort by score descending
		scores.sort((a, b) => b.score - a.score)
		const best = scores[0]

		this.logger.appendLine(
			`[QuestionEvaluator] Contextual analysis selected choice ${best.index + 1} (score: ${(best.score * 100).toFixed(0)}%)`,
		)

		return {
			question,
			choices,
			selectedIndex: best.index,
			selectedText: choices[best.index]?.text ?? "",
			reasoning: best.reasoning,
			evaluatedBy: "contextual",
		}
	}

	getStatus(): Record<string, any> {
		return {
			enabled: this.config.enabled,
			useFullTeam: this.config.useFullTeam,
			useContextualAnalysis: this.config.useContextualAnalysis,
			doResearchBeforeDeciding: this.config.doResearchBeforeDeciding,
		}
	}
}
