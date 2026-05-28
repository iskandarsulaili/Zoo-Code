import path from "path"
import crypto from "crypto"

import type {
	CodeIndexInfo,
	Experiments,
	ImprovementAction,
	LearnedPattern,
	LearningEvent,
	Logger,
	PromptContext,
	SelfImprovingManagerOptions,
	SelfImprovingScope,
	TaskEventInfo,
} from "./types"
import { experimentDefault } from "../../shared/experiments"
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
import { InsightsEngine } from "./InsightsEngine"
import { AutoModeOrchestrator } from "./AutoModeOrchestrator"
import type { AutoModeConfig } from "./AutoModeOrchestrator"
import { ModeFactoryService } from "./ModeFactoryService"
import type { InsightsReport } from "./InsightsEngine"
import { ReviewTeamService } from "./ReviewTeamService"
import type { ReviewTeamConfig } from "./ReviewTeamService"
import { QuestionEvaluatorService } from "./QuestionEvaluatorService"
import { ResilienceService } from "./ResilienceService"
import { ToolErrorHealer } from "./ToolErrorHealer"

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
	private readonly getMemoryBackend: SelfImprovingManagerOptions["getMemoryBackend"]
	private readonly getAgentMemoryUrl: SelfImprovingManagerOptions["getAgentMemoryUrl"]
	private readonly getSelfImprovingScope: SelfImprovingManagerOptions["getSelfImprovingScope"]
	private readonly getAutoSkillsScope: SelfImprovingManagerOptions["getAutoSkillsScope"]
	private readonly getWorkspacePath: SelfImprovingManagerOptions["getWorkspacePath"]
	private readonly curatorConfig: SelfImprovingManagerOptions["curatorConfig"]
	private readonly skillsManager: SelfImprovingManagerOptions["skillsManager"]
	public memoryStore: MemoryBackend
	public skillUsageStore: SkillUsageStore
	public curatorService: CuratorService
	public readonly reviewPromptFactory: ReviewPromptFactory
	public transcriptRecall: TranscriptRecall
	public readonly insightsEngine: InsightsEngine
	private actionExecutor: ActionExecutor
	private memoryBackendType: "builtin" | "agentmemory"
	private agentMemoryUrl: string | undefined
	private storageBasePath: string
	private autoModeOrchestrator: AutoModeOrchestrator
	private modeFactory: ModeFactoryService
	private reviewTeam: ReviewTeamService
	public questionEvaluator: QuestionEvaluatorService
	public resilienceService: ResilienceService
	public toolErrorHealer: ToolErrorHealer

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
		this.getMemoryBackend = options.getMemoryBackend
		this.getAgentMemoryUrl = options.getAgentMemoryUrl
		this.getSelfImprovingScope = options.getSelfImprovingScope
		this.getAutoSkillsScope = options.getAutoSkillsScope
		this.getWorkspacePath = options.getWorkspacePath
		this.curatorConfig = options.curatorConfig
		this.skillsManager = options.skillsManager
		this.memoryBackendType = this.resolveMemoryBackend(options.memoryBackend)
		this.agentMemoryUrl = this.resolveAgentMemoryUrl(options.agentMemoryUrl)
		this.storageBasePath = this.resolveStorageBasePath()
		this.memoryStore = this.createMemoryStore()
		this.skillUsageStore = this.createSkillUsageStore()
		this.actionExecutor = this.createActionExecutor()
		this.curatorService = this.createCuratorService()
		this.reviewPromptFactory = new ReviewPromptFactory()
		this.transcriptRecall = this.createTranscriptRecall()
		this.insightsEngine = new InsightsEngine(this.globalStoragePath)
		this.modeFactory = new ModeFactoryService(this.logger)
		this.autoModeOrchestrator = new AutoModeOrchestrator(this.logger, {
			enabled: this.getExperiments()?.selfImprovingAutoMode ?? true,
			reviewIntervalMs: 30000,
		})
		this.autoModeOrchestrator.setModeFactory(this.modeFactory)
		this.reviewTeam = new ReviewTeamService(this.logger, {
			enabled: this.getExperiments()?.selfImprovingReviewTeam ?? true,
		})
		this.questionEvaluator = new QuestionEvaluatorService(this.logger, {
			enabled: this.getExperiments()?.selfImprovingQuestionEvaluation ?? true,
			useFullTeam: this.getExperiments()?.selfImprovingReviewTeam ?? true,
		})
		this.questionEvaluator.setReviewTeam(this.reviewTeam)
		this.resilienceService = new ResilienceService(this.logger, {
			enabled: this.getExperiments()?.selfImprovingAutoMode ?? true,
		})
		this.toolErrorHealer = new ToolErrorHealer(this.logger, {
			enabled: this.getExperiments()?.selfImprovingAutoMode ?? true,
		})
	}

	setCustomModesManager(manager: any): void {
		this.modeFactory.setCustomModesManager(manager)
	}

	static isExperimentEnabled(experiments: Experiments | undefined, persistedEnabled?: boolean): boolean {
		// Check VS Code experiment flag first
		if (experiments && experiments[SELF_IMPROVING_EXPERIMENT_ID] === true) {
			return true
		}

		// Fallback: check persisted LearningStore config (state.json enabled flag)
		// This allows enabling self-improving without the VS Code experiment UI toggle
		if (persistedEnabled === true) {
			return true
		}

		return false
	}

	static isAutoSkillsEnabled(experiments: Experiments | undefined, persistedEnabled?: boolean): boolean {
		if (!SelfImprovingManager.isExperimentEnabled(experiments, persistedEnabled)) {
			return false
		}

		// Check auto-skills from experiments (explicitly set)
		if (experiments && "selfImprovingAutoSkills" in experiments) {
			return experiments.selfImprovingAutoSkills === true
		}

		// Fallback: check experiment default (experiments.ts config map)
		if (experimentDefault.selfImprovingAutoSkills === true) {
			return true
		}

		// Fallback: check persisted LearningStore config (state.json autoSkills flag)
		if (persistedEnabled === true) {
			return true
		}

		return false
	}

	async initialize(): Promise<void> {
		if (this.started) {
			return
		}

		try {
			const runtime = this.getOrCreateRuntime()
			await runtime.store.initialize()

			// Gate on VS Code experiment flag OR persisted config (state.json)
			const experimentEnabled = SelfImprovingManager.isExperimentEnabled(this.getExperiments())
			const storeEnabled = runtime.store.getConfig().enabled
			if (!experimentEnabled && !storeEnabled) {
				return
			}

			await this.memoryStore.initialize()
			await this.skillUsageStore.initialize()
			await this.transcriptRecall.initialize()
			await this.curatorService.initialize()
			await this.insightsEngine.initialize()
			this.started = true
			this.startTimers(runtime.store)

			// Wire up auto mode orchestrator with pattern analyzer and pattern provider
			this.autoModeOrchestrator.setPatternAnalyzer(runtime.patternAnalyzer)
			this.autoModeOrchestrator.setPatternProvider(() => runtime.store.getPatterns() as any[])
			await this.autoModeOrchestrator.start()

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
			// Also check persisted config as fallback (state.json enabled)
			const persistedEnabled = this.runtime?.store.getConfig().enabled ?? false
			const shouldEnable = enabled ?? (experimentEnabled || persistedEnabled)
			if (!shouldEnable) {
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
		await this.reconfigureIfNeeded()
		await this.handleExperimentChange()
	}

	async dispose(): Promise<void> {
		const enabled = SelfImprovingManager.isExperimentEnabled(this.getExperiments())
		if (!enabled && !this.started) {
			return
		}

		this.stopTimers()
		this.autoModeOrchestrator.stop()

		try {
			if (this.started) {
				await this.runtime?.store.persist()
				if (this.memoryStore instanceof MemoryStore) {
					this.memoryStore.takeSnapshot()
				}
			}

			await this.memoryStore.dispose()
			this.insightsEngine.dispose()
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
			await this.autoModeOrchestrator.onTaskCompleted(info.success ?? false)
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

	async recordCodeIndexEvent(taskId?: string, codeIndexInfo?: CodeIndexInfo): Promise<void> {
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

			const resolvedCodeIndexInfo = codeIndexInfo ?? this.runtime.codeIndexAdapter.getInfo()
			const event = this.runtime.feedbackCollector.createCodeIndexEvent(resolvedCodeIndexInfo, taskId)
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

			// Review patterns through multi-agent team
			const { approved: approvedPatterns, rejected: rejectedPatterns } =
				await this.reviewTeam.reviewPatterns(newPatterns)

			if (rejectedPatterns.length > 0) {
				this.logger.appendLine(`[SelfImproving] Review team rejected ${rejectedPatterns.length} patterns`)
			}

			const actions = this.runtime.improvementApplier.generateActions([
				...this.runtime.store.getPatterns(),
			] as LearnedPattern[])
			for (const action of actions) {
				this.runtime.store.addAction(action)
			}

			// Review actions through multi-agent team
			const { rejected: rejectedActions } = await this.reviewTeam.reviewActions(actions)

			if (rejectedActions.length > 0) {
				this.logger.appendLine(`[SelfImproving] Review team rejected ${rejectedActions.length} actions`)
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

			// Refresh the memory snapshot so newly learned patterns are visible in prompts
			if (this.memoryStore instanceof MemoryStore) {
				await this.memoryStore.takeSnapshot()
			}
			this.logger.appendLine(
				`[SelfImprovingManager] Review cycle: ${newPatterns.length} patterns, ${actions.length} actions`,
			)
			this.logger.appendLine("[SelfImprovingManager] Memory snapshot refreshed after review cycle")
		} catch (error) {
			this.logError("Review cycle error", error)
		} finally {
			this.reviewInFlight = false
		}
	}

	/**
	 * Immediately trigger a review cycle, bypassing the timer wait.
	 * Safe to call multiple times - runReviewCycle() has its own gating.
	 */
	public async triggerReview(): Promise<void> {
		if (!SelfImprovingManager.isExperimentEnabled(this.getExperiments())) {
			return
		}

		if (!this.started || !this.runtime) {
			return
		}

		await this.runReviewCycle()
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
		autoMode: Record<string, unknown>
		reviewTeam: Record<string, unknown>
		questionEvaluator: Record<string, unknown>
		resilience: Record<string, unknown>
		toolErrorHealer: Record<string, unknown>
	}> {
		const enabled = SelfImprovingManager.isExperimentEnabled(this.getExperiments())
		const curatorStatus = this.curatorService.getStatus()
		const reviewTeamStatus = {
			enabled: this.reviewTeam.getConfig().enabled,
			innovatorWeight: this.reviewTeam.getConfig().innovatorWeight,
			contrarianWeight: this.reviewTeam.getConfig().contrarianWeight,
			devilsAdvocateWeight: this.reviewTeam.getConfig().devilsAdvocateWeight,
			deciderThreshold: this.reviewTeam.getConfig().deciderThreshold,
		}
		const resilienceStatus = this.resilienceService.getStatus()
		const toolErrorHealerStatus = this.toolErrorHealer.getStatus()
		const questionEvaluatorStatus = this.questionEvaluator.getStatus()

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
				autoMode: this.autoModeOrchestrator.getStatus(),
				reviewTeam: reviewTeamStatus,
				questionEvaluator: questionEvaluatorStatus,
				resilience: resilienceStatus,
				toolErrorHealer: toolErrorHealerStatus,
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
				autoMode: this.autoModeOrchestrator.getStatus(),
				reviewTeam: reviewTeamStatus,
				questionEvaluator: questionEvaluatorStatus,
				resilience: resilienceStatus,
				toolErrorHealer: toolErrorHealerStatus,
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
				autoMode: this.autoModeOrchestrator.getStatus(),
				reviewTeam: reviewTeamStatus,
				questionEvaluator: questionEvaluatorStatus,
				resilience: resilienceStatus,
				toolErrorHealer: toolErrorHealerStatus,
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
				autoMode: this.autoModeOrchestrator.getStatus(),
				reviewTeam: reviewTeamStatus,
				questionEvaluator: questionEvaluatorStatus,
				resilience: resilienceStatus,
				toolErrorHealer: toolErrorHealerStatus,
			}
		}
	}

	/**
	 * Returns the current insights report with session analysis data.
	 * Includes token usage, tool usage patterns, error rates, and performance metrics.
	 */
	getInsightsReport(): InsightsReport {
		return this.insightsEngine.generateReport()
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
				store: new LearningStore(this.storageBasePath, this.logger),
				feedbackCollector: new FeedbackCollector(),
				patternAnalyzer: new PatternAnalyzer(),
				improvementApplier: new ImprovementApplier({
					getSkillNames: () => this.skillsManager?.getSkillNames() ?? [],
					getSkillProvenance: (name: string) => this.resolveSkillProvenance(name),
					getSkillProvenanceForSource: (name: string, source: "global" | "project") =>
						this.resolveSkillProvenance(name, source),
					hasSkill: (name: string, source: "global" | "project") =>
						this.skillsManager?.hasSkill?.(name, source) ?? false,
					isAutoSkillsEnabled: () =>
						SelfImprovingManager.isAutoSkillsEnabled(
							this.getExperiments(),
							this.runtime?.store.getConfig().enabled,
						),
					getAutoSkillsScope: () => this.resolveAutoSkillsScope(),
				}),
				codeIndexAdapter: new CodeIndexAdapter(this.logger, this.getCodeIndexInfo),
			}
		}

		return this.runtime
	}

	private resolveMemoryBackend(fallback?: "builtin" | "agentmemory"): "builtin" | "agentmemory" {
		return this.getMemoryBackend?.() ?? fallback ?? "builtin"
	}

	private resolveAgentMemoryUrl(fallback?: string): string | undefined {
		return this.getAgentMemoryUrl?.() ?? fallback
	}

	private resolveSelfImprovingScope(): SelfImprovingScope {
		return this.getSelfImprovingScope?.() ?? "global"
	}

	private resolveAutoSkillsScope(): SelfImprovingScope {
		return this.getAutoSkillsScope?.() ?? "workspace"
	}

	private resolveStorageBasePath(): string {
		if (this.resolveSelfImprovingScope() !== "workspace") {
			return this.globalStoragePath
		}

		const workspacePath = this.getWorkspacePath?.()
		if (!workspacePath) {
			return path.join(this.globalStoragePath, "workspace-scopes", "no-workspace")
		}

		const workspaceHash = crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16)
		return path.join(this.globalStoragePath, "workspace-scopes", workspaceHash)
	}

	private createMemoryStore(): MemoryBackend {
		return MemoryBackendFactory.create(
			this.memoryBackendType,
			this.storageBasePath,
			this.logger,
			this.agentMemoryUrl,
		)
	}

	private createSkillUsageStore(): SkillUsageStore {
		return new SkillUsageStore(this.storageBasePath, this.logger)
	}

	private createCuratorService(
		config: SelfImprovingManagerOptions["curatorConfig"] = this.curatorConfig,
	): CuratorService {
		return new CuratorService(this.storageBasePath, this.skillUsageStore, this.logger, config)
	}

	private createTranscriptRecall(): TranscriptRecall {
		return new TranscriptRecall(this.storageBasePath, this.logger)
	}

	private createActionExecutor(): ActionExecutor {
		return new ActionExecutor(this.memoryStore, this.skillUsageStore, this.logger, this.skillsManager)
	}

	private async reconfigureIfNeeded(): Promise<void> {
		const nextBackend = this.resolveMemoryBackend(this.memoryBackendType)
		const nextUrl = this.resolveAgentMemoryUrl(this.agentMemoryUrl)
		const nextStorageBasePath = this.resolveStorageBasePath()
		const backendChanged = nextBackend !== this.memoryBackendType || nextUrl !== this.agentMemoryUrl
		const storageChanged = nextStorageBasePath !== this.storageBasePath

		if (!backendChanged && !storageChanged) {
			return
		}

		const shouldRestart = this.started && SelfImprovingManager.isExperimentEnabled(this.getExperiments())
		if (shouldRestart) {
			this.stopTimers()
			await this.runtime?.store.persist()
			if (this.memoryStore instanceof MemoryStore) {
				this.memoryStore.takeSnapshot()
			}
		}

		await this.memoryStore.dispose()
		this.started = false
		this.runtime = undefined
		this.promptRevision = 0

		this.memoryBackendType = nextBackend
		this.agentMemoryUrl = nextUrl
		this.storageBasePath = nextStorageBasePath
		this.memoryStore = this.createMemoryStore()
		this.skillUsageStore = this.createSkillUsageStore()
		this.actionExecutor = this.createActionExecutor()
		this.curatorService = this.createCuratorService()
		this.transcriptRecall = this.createTranscriptRecall()

		if (shouldRestart) {
			await this.initialize()
		}

		if (backendChanged) {
			this.logger.appendLine(
				`[SelfImprovingManager] Memory backend configured: ${this.memoryBackendType}${this.agentMemoryUrl ? ` (${this.agentMemoryUrl})` : ""}`,
			)
		}
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
			config.reviewOnEveryTurn ||
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
				actions.filter(
					(action) =>
						action.actionType === "SKILL_SUGGESTION" ||
						action.actionType === "SKILL_CREATE" ||
						action.actionType === "SKILL_UPDATE",
				).length,
		})
	}

	private resolveSkillProvenance(name: string, source?: "global" | "project"): string {
		// 1. Check explicit provenance from SkillUsageStore (agent-created records)
		const agentRecord = this.skillUsageStore.getAll().find((record) => {
			if (record.createdBy !== "agent" || record.skillName !== name) {
				return false
			}

			if (!source) {
				return true
			}

			return record.skillId === this.buildSkillId(name, source)
		})
		if (agentRecord) {
			return agentRecord.createdBy
		}

		// 2. Check SkillsManager for known user skills
		const managerProvenance = source
			? this.skillsManager?.getSkillProvenanceForSource?.(name, source)
			: this.skillsManager?.getSkillProvenance(name)

		if (managerProvenance && managerProvenance !== "unknown") {
			return managerProvenance
		}

		// 3. Heuristic: Check if skill name matches known bundled patterns
		if (this.isKnownBundledSkill(name)) {
			return "bundled"
		}

		return "unknown"
	}

	/**
	 * Heuristic check: determine if a skill name matches known bundled/hub patterns.
	 * This serves as a fallback when explicit provenance records are unavailable.
	 */
	private isKnownBundledSkill(skillId: string): boolean {
		const bundledPatterns = [/^built-in-/i, /^core-/i, /^default-/i]
		return bundledPatterns.some((pattern) => pattern.test(skillId))
	}

	private buildSkillId(name: string, source: "global" | "project"): string {
		return `skill:${source}:${name}`
	}

	private logError(context: string, error: unknown): void {
		this.logger.appendLine(
			`[SelfImprovingManager] ${context}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}
