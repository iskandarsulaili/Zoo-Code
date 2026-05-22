import type {
	ActionType,
	FeedbackSignal,
	ImprovementAction,
	LearnedPattern,
	LearningConfig,
	LearningEvent,
	LearningState,
	LearningTelemetry,
	PatternState,
	PatternType,
} from "@roo-code/types"

// Re-export shared types for convenience
export type {
	ActionType,
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
	getExperiments: () => Record<string, boolean> | undefined
	getCodeIndexInfo?: () => CodeIndexInfo
	/** Optional SkillsManager reference for skill telemetry integration */
	skillsManager?: {
		getSkillNames(): string[]
		getSkillProvenance(name: string): string
	}
}

/**
 * Default learning configuration
 */
export const DEFAULT_CONFIG: LearningConfig = {
	enabled: false,
	reviewOnTurnCount: 10,
	reviewOnToolIterationCount: 50,
	maxStoredPatterns: 100,
	maxStoredEvents: 500,
	maxPromptPatterns: 5,
	curatorEnabled: true,
	curatorIntervalMs: 3600000,
	staleAfterDays: 14,
	archiveAfterDays: 60,
	codeIndexCorrelationEnabled: true,
}

/**
 * Empty learning state for initialization
 */
export const EMPTY_STATE: LearningState = {
	version: 1,
	config: DEFAULT_CONFIG,
	counters: {
		userTurnsSinceReview: 0,
		toolIterationsSinceReview: 0,
	},
	patterns: [],
	archivedPatterns: [],
	recentEvents: [],
	pendingActions: [],
	telemetry: {
		promptEnrichmentUses: 0,
		toolPreferenceUses: 0,
		errorAvoidanceUses: 0,
		skillSuggestionCount: 0,
	},
}
