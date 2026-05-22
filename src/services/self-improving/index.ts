/**
 * Self-Improving Module
 *
 * A standalone, experiment-gated subsystem that learns from task outcomes
 * to improve prompt guidance, tool preferences, and error avoidance over time.
 *
 * Architecture: Hermes-agent symbolic learning loop adapted to Zoo-Code patterns.
 * See ARCHITECTURE.md for full design documentation.
 */

export { SelfImprovingManager } from "./SelfImprovingManager"
export { LearningStore } from "./LearningStore"
export { FeedbackCollector } from "./FeedbackCollector"
export { PatternAnalyzer } from "./PatternAnalyzer"
export { ImprovementApplier } from "./ImprovementApplier"
export { CodeIndexAdapter } from "./CodeIndexAdapter"
export { MemoryStore } from "./MemoryStore"
export { SkillUsageStore } from "./SkillUsageStore"
export { ActionExecutor } from "./ActionExecutor"

export type { CodeIndexInfo, Logger, PromptContext, SelfImprovingManagerOptions, TaskEventInfo } from "./types"
export type { MemoryStoreType } from "./MemoryStore"
export type { SkillTelemetryRecord, SkillProvenance, SkillLifecycleState } from "./SkillUsageStore"

export { DEFAULT_CONFIG, EMPTY_STATE } from "./types"
