import type {
	ImprovementAction,
	LearnedPattern,
	LearningEvent,
	Logger,
	PromptContext,
	SelfImprovingManagerOptions,
	TaskEventInfo,
} from "./types"
import { LearningStore } from "./LearningStore"
import { FeedbackCollector } from "./FeedbackCollector"
import { PatternAnalyzer } from "./PatternAnalyzer"
import { ImprovementApplier } from "./ImprovementApplier"
import { CodeIndexAdapter } from "./CodeIndexAdapter"

const SELF_IMPROVING_EXPERIMENT_ID = "selfImproving"
const REVIEW_CHECK_INTERVAL_MS = 60_000

type Runtime = {
	store: LearningStore
	feedbackCollector: FeedbackCollector
	patternAnalyzer: PatternAnalyzer
	improvementApplier: ImprovementApplier
	codeIndexAdapter: CodeIndexAdapter
}

export class SelfImprovingManager {
	private readonly globalStoragePath: string
	private readonly logger: Logger
	private readonly getExperiments: () => Record<string, boolean> | undefined
	private readonly getCodeIndexInfo: SelfImprovingManagerOptions["getCodeIndexInfo"]

	private runtime: Runtime | undefined
	private started = false
	private reviewTimer: ReturnType<typeof setInterval> | null = null
	private curatorTimer: ReturnType<typeof setInterval> | null = null
	private promptRevision = 0

	constructor(options: SelfImprovingManagerOptions) {
		this.globalStoragePath = options.globalStoragePath
		this.logger = options.logger
		this.getExperiments = options.getExperiments
		this.getCodeIndexInfo = options.getCodeIndexInfo
	}

	static isExperimentEnabled(experiments: Record<string, boolean> | undefined): boolean {
		if (!experiments) {
			return false
		}

		return experiments[SELF_IMPROVING_EXPERIMENT_ID] === true
	}

	async initialize(): Promise<void> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return
		}

		if (this.started) {
			return
		}

		try {
			const runtime = this.getOrCreateRuntime()
			await runtime.store.initialize()
			this.started = true
			this.startTimers(runtime.store)
			this.logger.appendLine(
				"[SelfImprovingManager] Initialized: " +
					`${runtime.store.getPatterns().length} patterns, ` +
					`${runtime.store.getRecentEvents().length} events`,
			)
		} catch (error) {
			this.stopTimers()
			this.started = false
			this.runtime = undefined
			this.logError("Initialization error", error)
		}
	}

	async handleExperimentChange(enabled: boolean): Promise<void> {
		try {
			const experimentEnabled = SelfImprovingManager.isExperimentEnabled(this.getExperiments())
			if (!enabled || !experimentEnabled) {
				await this.dispose()
				return
			}

			await this.initialize()
		} catch (error) {
			this.logError("Experiment change handling error", error)
		}
	}

	async dispose(): Promise<void> {
		const enabled = SelfImprovingManager.isExperimentEnabled(this.getExperiments())
		if (!enabled && !this.started) {
			return
		}

		this.stopTimers()

		try {
			if (this.started) {
				await this.runtime?.store.persist()
			}
		} catch (error) {
			this.logError("Persist on dispose error", error)
		} finally {
			this.started = false
			this.promptRevision = 0
			this.runtime = undefined
		}
	}

	async recordTaskCompletion(info: TaskEventInfo): Promise<void> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return
		}

		if (!this.started || !this.runtime) {
			return
		}

		try {
			const event = this.runtime.feedbackCollector.createTaskEvent(info)
			this.runtime.store.addEvent(event)
			this.runtime.store.incrementToolIterations(
				Math.max(1, info.toolIterationCount ?? info.toolNames?.length ?? 1),
			)
			await this.checkReviewTriggers(this.runtime.store)
		} catch (error) {
			this.logError("recordTaskCompletion error", error)
		}
	}

	async recordUserCorrection(info: TaskEventInfo): Promise<void> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return
		}

		if (!this.started || !this.runtime) {
			return
		}

		try {
			const event = this.runtime.feedbackCollector.createCorrectionEvent(info)
			this.runtime.store.addEvent(event)
			await this.checkReviewTriggers(this.runtime.store)
		} catch (error) {
			this.logError("recordUserCorrection error", error)
		}
	}

	async recordUserTurn(): Promise<void> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return
		}

		if (!this.started || !this.runtime) {
			return
		}

		try {
			this.runtime.store.incrementUserTurns()
			await this.checkReviewTriggers(this.runtime.store)
		} catch (error) {
			this.logError("recordUserTurn error", error)
		}
	}

	async recordCodeIndexEvent(taskId?: string): Promise<void> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return
		}

		if (!this.started || !this.runtime) {
			return
		}

		try {
			if (!this.runtime.store.getConfig().codeIndexCorrelationEnabled) {
				return
			}

			const codeIndexInfo = this.runtime.codeIndexAdapter.getInfo()
			const event = this.runtime.feedbackCollector.createCodeIndexEvent(codeIndexInfo, taskId)
			this.runtime.store.addEvent(event)
		} catch (error) {
			this.logError("recordCodeIndexEvent error", error)
		}
	}

	async runReviewCycle(): Promise<void> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return
		}

		if (!this.started || !this.runtime) {
			return
		}

		try {
			const events = [...this.runtime.store.getRecentEvents()] as LearningEvent[]
			if (events.length === 0) {
				return
			}

			const existingPatterns = [...this.runtime.store.getPatterns()] as LearnedPattern[]
			const newPatterns = this.runtime.patternAnalyzer.analyze(events, existingPatterns)
			for (const pattern of newPatterns) {
				this.runtime.store.addPattern(pattern)
			}

			const actions = this.runtime.improvementApplier.generateActions([
				...this.runtime.store.getPatterns(),
			] as LearnedPattern[])
			for (const action of actions) {
				this.runtime.store.addAction(action)
			}

			this.updateReviewTelemetry(this.runtime.store, actions)
			this.promptRevision += 1
			this.runtime.store.resetCounters()
			await this.runtime.store.persist()
			this.logger.appendLine(
				`[SelfImprovingManager] Review cycle: ${newPatterns.length} patterns, ${actions.length} actions`,
			)
		} catch (error) {
			this.logError("Review cycle error", error)
		}
	}

	async runCuratorCycle(): Promise<void> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return
		}

		if (!this.started || !this.runtime) {
			return
		}

		try {
			const config = this.runtime.store.getConfig()
			const now = Date.now()
			const staleThreshold = now - config.staleAfterDays * 24 * 60 * 60 * 1000
			const archiveThreshold = now - config.archiveAfterDays * 24 * 60 * 60 * 1000
			let transitions = 0

			for (const pattern of [...this.runtime.store.getPatterns()]) {
				if (pattern.state === "active" && pattern.lastSeenAt < staleThreshold) {
					this.runtime.store.updatePattern(pattern.id, { state: "stale" })
					transitions += 1
				} else if (pattern.state === "stale" && pattern.lastSeenAt < archiveThreshold) {
					this.runtime.store.archivePattern(pattern.id)
					transitions += 1
				}
			}

			if (transitions > 0) {
				this.runtime.store.updateTelemetry({ lastCuratorRunAt: now })
				await this.runtime.store.persist()
				this.logger.appendLine(`[SelfImprovingManager] Curator cycle: ${transitions} patterns transitioned`)
			}
		} catch (error) {
			this.logError("Curator cycle error", error)
		}
	}

	getPromptContext(): PromptContext | undefined {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return undefined
		}

		if (!this.started || !this.runtime) {
			return undefined
		}

		try {
			return this.runtime.improvementApplier.getPromptContext(
				[...this.runtime.store.getPatterns()] as LearnedPattern[],
				this.runtime.store.getConfig().maxPromptPatterns,
				this.promptRevision,
			)
		} catch (error) {
			this.logError("getPromptContext error", error)
			return undefined
		}
	}

	getPromptContextString(): string {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return ""
		}

		if (!this.started) {
			return ""
		}

		try {
			const context = this.getPromptContext()
			if (!context || context.entries.length === 0) {
				return ""
			}

			return `\n## Learned Guidance\n${context.entries.map((entry) => `- [${entry.type}] ${entry.summary}`).join("\n")}\n`
		} catch {
			return ""
		}
	}

	getStatus(): {
		enabled: boolean
		started: boolean
		patternCount: number
		eventCount: number
		actionCount: number
		lastReviewAt?: number
		lastCuratorRunAt?: number
	} {
		const enabled = SelfImprovingManager.isExperimentEnabled(this.getExperiments())
		if (!enabled) {
			return { enabled: false, started: false, patternCount: 0, eventCount: 0, actionCount: 0 }
		}

		if (!this.started || !this.runtime) {
			return { enabled: true, started: false, patternCount: 0, eventCount: 0, actionCount: 0 }
		}

		try {
			const telemetry = this.runtime.store.getTelemetry()
			return {
				enabled: true,
				started: true,
				patternCount: this.runtime.store.getPatterns().length,
				eventCount: this.runtime.store.getRecentEvents().length,
				actionCount: this.runtime.store.getPendingActions().length,
				lastReviewAt: telemetry.lastReviewAt,
				lastCuratorRunAt: telemetry.lastCuratorRunAt,
			}
		} catch {
			return { enabled: true, started: true, patternCount: 0, eventCount: 0, actionCount: 0 }
		}
	}

	async reset(): Promise<void> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return
		}

		if (!this.started || !this.runtime) {
			return
		}

		try {
			await this.runtime.store.reset()
			this.promptRevision = 0
			this.logger.appendLine("[SelfImprovingManager] Learning state reset")
		} catch (error) {
			this.logError("Reset error", error)
		}
	}

	private getOrCreateRuntime(): Runtime {
		if (!this.runtime) {
			this.runtime = {
				store: new LearningStore(this.globalStoragePath, this.logger),
				feedbackCollector: new FeedbackCollector(),
				patternAnalyzer: new PatternAnalyzer(),
				improvementApplier: new ImprovementApplier(),
				codeIndexAdapter: new CodeIndexAdapter(this.getCodeIndexInfo),
			}
		}

		return this.runtime
	}

	private startTimers(store: LearningStore): void {
		this.stopTimers()
		const config = store.getConfig()
		this.reviewTimer = setInterval(() => {
			void this.runReviewCycle()
		}, REVIEW_CHECK_INTERVAL_MS)

		if (config.curatorEnabled) {
			this.curatorTimer = setInterval(() => {
				void this.runCuratorCycle()
			}, config.curatorIntervalMs)
		}
	}

	private stopTimers(): void {
		if (this.reviewTimer) {
			clearInterval(this.reviewTimer)
			this.reviewTimer = null
		}

		if (this.curatorTimer) {
			clearInterval(this.curatorTimer)
			this.curatorTimer = null
		}
	}

	private async checkReviewTriggers(store: LearningStore): Promise<void> {
		const counters = store.getCounters()
		const config = store.getConfig()
		if (
			counters.userTurnsSinceReview >= config.reviewOnTurnCount ||
			counters.toolIterationsSinceReview >= config.reviewOnToolIterationCount
		) {
			await this.runReviewCycle()
		}
	}

	private updateReviewTelemetry(store: LearningStore, actions: ImprovementAction[]): void {
		const telemetry = store.getTelemetry()
		store.updateTelemetry({
			lastReviewAt: Date.now(),
			promptEnrichmentUses:
				telemetry.promptEnrichmentUses +
				actions.filter((action) => action.actionType === "PROMPT_ENRICHMENT").length,
			toolPreferenceUses:
				telemetry.toolPreferenceUses +
				actions.filter((action) => action.actionType === "TOOL_PREFERENCE").length,
			errorAvoidanceUses:
				telemetry.errorAvoidanceUses +
				actions.filter((action) => action.actionType === "ERROR_AVOIDANCE").length,
			skillSuggestionCount:
				telemetry.skillSuggestionCount +
				actions.filter((action) => action.actionType === "SKILL_SUGGESTION").length,
		})
	}

	private logError(context: string, error: unknown): void {
		this.logger.appendLine(
			`[SelfImprovingManager] ${context}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}
