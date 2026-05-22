import {
	DEFAULT_LEARNING_CONFIG,
	EMPTY_LEARNING_STATE,
	type ActionType,
	type Experiments,
	type FeedbackSignal,
	type ImprovementAction,
	type LearnedPattern,
	type LearningConfig,
	type LearningEvent,
	type LearningState,
	type LearningTelemetry,
	type PatternState,
	type PatternType,
} from "@roo-code/types"

// Re-export shared types for convenience
export type {
	ActionType,
	Experiments,
	FeedbackSignal,
	ImprovementAction,
	LearnedPattern,
	LearningConfig,
	LearningEvent,
	LearningState,
	LearningTelemetry,
	PatternState,
	PatternType,
}

/**
 * Output channel logger interface - abstracts VS Code OutputChannel
 */
export interface Logger {
	appendLine(message: string): void
}

/**
 * Code index adapter contract - read-only view of code index availability
 */
export interface CodeIndexInfo {
	available: boolean
	hits: number
	topScore?: number
}

/**
 * Task lifecycle event adapter - normalizes task events into learning signals
 */
export interface TaskEventInfo {
	taskId: string
	mode?: string
	workspacePath?: string
	success?: boolean
	corrected?: boolean
	toolNames?: string[]
	userTurnCount?: number
	toolIterationCount?: number
	errorKey?: string
	promptFingerprint?: string
}

/**
 * Prompt context result - bounded set of learned guidance for prompt injection
 */
export interface PromptContext {
	entries: Array<{
		type: PatternType
		summary: string
		confidence: number
	}>
	revision: number
}

/**
 * Manager options for construction
 */
export interface SelfImprovingManagerOptions {
	globalStoragePath: string
	logger: Logger
	getExperiments: () => Experiments | undefined
	getCodeIndexInfo?: () => CodeIndexInfo
	/** Memory backend type: "builtin" (default) or "agentmemory" */
	memoryBackend?: "builtin" | "agentmemory"
	/** agentmemory server URL (default: http://localhost:4001) */
	agentMemoryUrl?: string
	/** Optional curator configuration overrides */
	curatorConfig?: {
		intervalMs?: number
		minIdleMs?: number
		firstRunDeferred?: boolean
		staleAfterDays?: number
		archiveAfterDays?: number
		backupsEnabled?: boolean
		maxBackups?: number
	}
	/** Optional SkillsManager reference for skill telemetry integration */
	skillsManager?: {
		getSkillNames(): string[]
		getSkillProvenance(name: string): string
	}
}

/**
 * Shared learning defaults re-exported for local convenience.
 */
export const DEFAULT_CONFIG: LearningConfig = DEFAULT_LEARNING_CONFIG

/**
 * Shared empty learning state re-exported for local convenience.
 */
export const EMPTY_STATE: LearningState = EMPTY_LEARNING_STATE
