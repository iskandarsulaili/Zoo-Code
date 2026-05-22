import type {
	Experiments,
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
import type { MemoryBackend } from "./MemoryBackend"
import { MemoryBackendFactory } from "./MemoryBackendFactory"
import { MemoryStore } from "./MemoryStore"
import { SkillUsageStore } from "./SkillUsageStore"
import { ActionExecutor } from "./ActionExecutor"
import { CuratorService } from "./CuratorService"
import type { CuratorReport } from "./CuratorService"
import { ReviewPromptFactory } from "./ReviewPromptFactory"
import { TranscriptRecall } from "./TranscriptRecall"

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
	private readonly getExperiments: () => Experiments | undefined
	private readonly getCodeIndexInfo: SelfImprovingManagerOptions["getCodeIndexInfo"]
	public readonly memoryStore: MemoryBackend
	public readonly skillUsageStore: SkillUsageStore
	public readonly curatorService: CuratorService
	public readonly reviewPromptFactory: ReviewPromptFactory
	public readonly transcriptRecall: TranscriptRecall
	private readonly actionExecutor: ActionExecutor

	private runtime: Runtime | undefined
	private started = false
	private reviewTimer: ReturnType<typeof setInterval> | null = null
	private curatorTimer: ReturnType<typeof setInterval> | null = null
	private promptRevision = 0
	private lastUserActivityAt = 0
	private reviewInFlight = false
	private curatorInFlight = false

	constructor(options: SelfImprovingManagerOptions) {
		this.globalStoragePath = options.globalStoragePath
		this.logger = options.logger
		this.getExperiments = options.getExperiments
		this.getCodeIndexInfo = options.getCodeIndexInfo
		this.memoryStore = MemoryBackendFactory.create(
			options.memoryBackend || "builtin",
			options.globalStoragePath,
			options.logger,
			options.agentMemoryUrl,
		)
		this.skillUsageStore = new SkillUsageStore(options.globalStoragePath, options.logger)
		this.actionExecutor = new ActionExecutor(this.memoryStore, this.skillUsageStore, options.logger)
		this.curatorService = new CuratorService(
			options.globalStoragePath,
			this.skillUsageStore,
			options.logger,
			options.curatorConfig,
		)
		this.reviewPromptFactory = new ReviewPromptFactory()
		this.transcriptRecall = new TranscriptRecall(options.globalStoragePath, options.logger)
	}

	static isExperimentEnabled(experiments: Experiments | undefined): boolean {
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
			await this.memoryStore.initialize()
			await this.skillUsageStore.initialize()
			await this.transcriptRecall.initialize()
			await this.curatorService.initialize()
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

	async handleExperimentChange(enabled?: boolean): Promise<void> {
		try {
			const experimentEnabled = SelfImprovingManager.isExperimentEnabled(this.getExperiments())
			const shouldEnable = enabled ?? experimentEnabled
			if (!shouldEnable || !experimentEnabled) {
				await this.dispose()
				return
			}

			await this.initialize()
		} catch (error) {
			this.logError("Experiment change handling error", error)
		}
	}

	/**
	 * Handle settings change — called when experiments are updated.
	 * This enables/disables the module at runtime.
	 */
	async onSettingsChanged(_experiments: Experiments | undefined): Promise<void> {
		await this.handleExperimentChange()
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
				if (this.memoryStore instanceof MemoryStore) {
					this.memoryStore.takeSnapshot()
				}
			}

			await this.memoryStore.dispose()
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
			this.lastUserActivityAt = event.timestamp
			await this.transcriptRecall.record({
				id: event.id,
				timestamp: event.timestamp,
				taskId: info.taskId,
				mode: info.mode,
				summary: info.success
					? `Task completed: ${info.mode || "unknown"}`
					: `Task failed: ${info.errorKey || "unknown"}`,
				signal: info.success ? "TASK_SUCCESS" : "TASK_FAILURE",
				workspacePath: info.workspacePath,
				toolNames: info.toolNames,
				errorKey: info.errorKey,
				success: info.success,
			})
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
			this.lastUserActivityAt = event.timestamp
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
			this.lastUserActivityAt = Date.now()
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
			this.lastUserActivityAt = event.timestamp
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

		if (this.reviewInFlight) {
			this.logger.appendLine("[SelfImprovingManager] Review cycle already in progress, skipping")
			return
		}
		this.reviewInFlight = true

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

			const pendingActions = [...this.runtime.store.getPendingActions()] as ImprovementAction[]
			if (pendingActions.length > 0) {
				const succeeded = await this.actionExecutor.executeBatch(pendingActions)
				for (const actionId of succeeded) {
					this.runtime.store.removeAction(actionId)
				}

				this.logger.appendLine(
					`[SelfImprovingManager] Executed ${succeeded.size}/${pendingActions.length} actions`,
				)
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
		} finally {
			this.reviewInFlight = false
		}
	}

	async runCuratorCycle(): Promise<CuratorReport | undefined> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return undefined
		}

		if (!this.started || !this.runtime) {
			return undefined
		}

		if (this.curatorInFlight) {
			return undefined
		}
		this.curatorInFlight = true

		try {
			const now = Date.now()
			const report = await this.curatorService.run(
				now,
				this.lastUserActivityAt > 0 ? this.lastUserActivityAt : undefined,
			)
			this.runtime.store.updateTelemetry({ lastCuratorRunAt: report.timestamp })

			if (report.transitions.length > 0) {
				this.logger.appendLine(`[SelfImprovingManager] Curator cycle: ${report.transitions.length} transitions`)
			}

			return report
		} catch (error) {
			this.logger.appendLine(
				`[SelfImprovingManager] Curator cycle error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return undefined
		} finally {
			this.curatorInFlight = false
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
		if (!this.started) {
			return ""
		}

		try {
			if (this.memoryStore instanceof MemoryStore) {
				return this.memoryStore.getSnapshotString()
			}

			return ""
		} catch {
			return ""
		}
	}

	async getStatus(): Promise<{
		enabled: boolean
		started: boolean
		patternCount: number
		eventCount: number
		actionCount: number
		memoryEntries: number
		memoryBackend?: string
		skillRecords: number
		curatorStatus: ReturnType<CuratorService["getStatus"]>
		lastReviewAt?: number
		lastCuratorRunAt?: number
	}> {
		const enabled = SelfImprovingManager.isExperimentEnabled(this.getExperiments())
		const curatorStatus = this.curatorService.getStatus()
		if (!enabled) {
			return {
				enabled: false,
				started: false,
				patternCount: 0,
				eventCount: 0,
				actionCount: 0,
				memoryEntries: 0,
				skillRecords: 0,
				curatorStatus,
			}
		}

		if (!this.started || !this.runtime) {
			return {
				enabled: true,
				started: false,
				patternCount: 0,
				eventCount: 0,
				actionCount: 0,
				memoryEntries: 0,
				skillRecords: 0,
				curatorStatus,
			}
		}

		try {
			const telemetry = this.runtime.store.getTelemetry()
			const memStats = await this.memoryStore.getStats()
			const skillStats = this.skillUsageStore.getStats()
			return {
				enabled: true,
				started: true,
				patternCount: this.runtime.store.getPatterns().length,
				eventCount: this.runtime.store.getRecentEvents().length,
				actionCount: this.runtime.store.getPendingActions().length,
				memoryEntries: memStats.entryCount,
				memoryBackend: memStats.backend,
				skillRecords: skillStats.total,
				curatorStatus,
				lastReviewAt: telemetry.lastReviewAt,
				lastCuratorRunAt: telemetry.lastCuratorRunAt,
			}
		} catch {
			return {
				enabled: true,
				started: true,
				patternCount: 0,
				eventCount: 0,
				actionCount: 0,
				memoryEntries: 0,
				skillRecords: 0,
				curatorStatus,
			}
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
				codeIndexAdapter: new CodeIndexAdapter(this.logger, this.getCodeIndexInfo),
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
				this.runCuratorCycle().catch((error) => {
					this.logger.appendLine(
						`[SelfImprovingManager] Curator cycle error: ${error instanceof Error ? error.message : String(error)}`,
					)
				})
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
