import crypto from "crypto"

import type { ImprovementAction, LearnedPattern, PromptContext } from "./types"

/**
 * ImprovementApplier - converts learned patterns into actionable improvements.
 *
 * Generates:
 * - Prompt enrichment context (bounded, ordered by confidence)
 * - Tool preference adjustments
 * - Error avoidance hints
 * - Skill suggestions (for future user approval)
 */
export class ImprovementApplier {
	/**
	 * Generate prompt context from active patterns.
	 * Returns at most maxEntries entries, ordered by confidence descending.
	 */
	getPromptContext(patterns: LearnedPattern[], maxEntries = 5, revision = 0): PromptContext {
		const activePatterns = patterns
			.filter((pattern) => pattern.state === "active")
			.sort((left, right) => right.confidenceScore - left.confidenceScore)
			.slice(0, maxEntries)

		return {
			entries: activePatterns.map((pattern) => ({
				type: pattern.patternType,
				summary: pattern.summary,
				confidence: pattern.confidenceScore,
			})),
			revision,
		}
	}

	/**
	 * Generate improvement actions from patterns.
	 */
	generateActions(patterns: LearnedPattern[]): ImprovementAction[] {
		const actions: ImprovementAction[] = []
		const now = Date.now()

		for (const pattern of patterns) {
			if (pattern.state !== "active") {
				continue
			}

			switch (pattern.patternType) {
				case "error":
					actions.push(this.createErrorAvoidanceAction(pattern, now))
					break
				case "tool":
					actions.push(this.createToolPreferenceAction(pattern, now))
					break
				case "prompt":
					actions.push(this.createPromptEnrichmentAction(pattern, now))
					break
				case "skill":
					actions.push(this.createSkillSuggestionAction(pattern, now))
					break
			}
		}

		return actions
	}

	/**
	 * Create an error avoidance action from an error pattern.
	 */
	private createErrorAvoidanceAction(pattern: LearnedPattern, now: number): ImprovementAction {
		return {
			id: crypto.randomUUID(),
			actionType: "ERROR_AVOIDANCE",
			target: "task-execution",
			payload: {
				patternId: pattern.id,
				errorKeys: pattern.context.errorKeys,
				summary: pattern.summary,
				confidence: pattern.confidenceScore,
			},
			timestamp: now,
		}
	}

	/**
	 * Create a tool preference action from a tool pattern.
	 */
	private createToolPreferenceAction(pattern: LearnedPattern, now: number): ImprovementAction {
		return {
			id: crypto.randomUUID(),
			actionType: "TOOL_PREFERENCE",
			target: "task-execution",
			payload: {
				patternId: pattern.id,
				toolNames: pattern.context.toolNames,
				summary: pattern.summary,
				confidence: pattern.confidenceScore,
			},
			timestamp: now,
		}
	}

	/**
	 * Create a prompt enrichment action from a prompt pattern.
	 */
	private createPromptEnrichmentAction(pattern: LearnedPattern, now: number): ImprovementAction {
		return {
			id: crypto.randomUUID(),
			actionType: "PROMPT_ENRICHMENT",
			target: "system-prompt",
			payload: {
				patternId: pattern.id,
				summary: pattern.summary,
				confidence: pattern.confidenceScore,
			},
			timestamp: now,
		}
	}

	/**
	 * Create a skill suggestion action from a skill pattern.
	 */
	private createSkillSuggestionAction(pattern: LearnedPattern, now: number): ImprovementAction {
		return {
			id: crypto.randomUUID(),
			actionType: "SKILL_SUGGESTION",
			target: "skills-manager",
			payload: {
				patternId: pattern.id,
				summary: pattern.summary,
				confidence: pattern.confidenceScore,
				toolNames: pattern.context.toolNames,
			},
			timestamp: now,
		}
	}
}
