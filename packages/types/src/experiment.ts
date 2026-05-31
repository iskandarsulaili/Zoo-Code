import { z } from "zod"

import type { Keys, Equals, AssertEqual } from "./type-fu.js"

/**
 * ExperimentId
 */

export const experimentIds = [
	"preventFocusDisruption",
	"imageGeneration",
	"runSlashCommand",
	"customTools",
	"selfImproving",
	"selfImprovingAutoSkills",
	"selfImprovingAutoMode",
	"selfImprovingReviewTeam",
	"selfImprovingFullTrust",
	"selfImprovingQuestionEvaluation",
	"selfImprovingPromptQuality",
	"selfImprovingToolPreference",
	"selfImprovingSkillMerge",
	"selfImprovingPersistCounts",
	"selfImprovingCodeIndex",
	"oneShotOrchestrator",
	"kaizenOrchestrator",
	"preventionEngine",
	"cascadeTracker",
	"resilienceService",
	"toolErrorHealer",
	"verificationEngine",
	"requirementsVerification",
	"recoveryContext",
	"selfImprovingSpecializedSkills",
	"taskPatternLearning",
] as const

export const experimentIdsSchema = z.enum(experimentIds)

export type ExperimentId = z.infer<typeof experimentIdsSchema>

/**
 * Experiments
 */

export const experimentsSchema = z.object({
	preventFocusDisruption: z.boolean().optional(),
	imageGeneration: z.boolean().optional(),
	runSlashCommand: z.boolean().optional(),
	customTools: z.boolean().optional(),
	selfImproving: z.boolean().optional(),
	selfImprovingAutoSkills: z.boolean().optional(),
	selfImprovingAutoMode: z.boolean().optional(),
	selfImprovingReviewTeam: z.boolean().optional(),
	selfImprovingFullTrust: z.boolean().optional(),
	selfImprovingQuestionEvaluation: z.boolean().optional(),
	selfImprovingPromptQuality: z.boolean().optional(),
	selfImprovingToolPreference: z.boolean().optional(),
	selfImprovingSkillMerge: z.boolean().optional(),
	selfImprovingPersistCounts: z.boolean().optional(),
	selfImprovingCodeIndex: z.boolean().optional(),
	oneShotOrchestrator: z.boolean().optional(),
	kaizenOrchestrator: z.boolean().optional(),
	preventionEngine: z.boolean().optional(),
	cascadeTracker: z.boolean().optional(),
	resilienceService: z.boolean().optional(),
	toolErrorHealer: z.boolean().optional(),
	verificationEngine: z.boolean().optional(),
	requirementsVerification: z.boolean().optional(),
	recoveryContext: z.boolean().optional(),
	selfImprovingSpecializedSkills: z.boolean().optional(),
	taskPatternLearning: z.boolean().optional(),

	/**
	 * List of mode slugs that should skip code quality verification in AttemptCompletionTool.
	 * Default: ["research"]
	 */
	lenientModes: z.array(z.string()).optional(),

	/**
	 * Default verification level for requirements verification in AttemptCompletionTool.
	 * - "strict": All requirements must be verified before completion (default)
	 * - "lenient": Requirements are tracked but non-blocking — log warnings instead of blocking
	 * - "bypass": Skip requirements verification entirely
	 * @default "strict"
	 */
	verificationLevel: z.enum(["strict", "lenient", "bypass"]).optional(),

	/**
	 * Per-mode verification level overrides.
	 * Keyed by mode slug, values override the default verificationLevel for that mode.
	 */
	verificationLevels: z.record(z.enum(["strict", "lenient", "bypass"])).optional(),

	/** Gate config — whether to run build check */
	verificationCheckBuild: z.boolean().optional(),
	/** Gate config — whether to run lint check */
	verificationCheckLint: z.boolean().optional(),
	/** Gate config — whether to run type check */
	verificationCheckTypes: z.boolean().optional(),
	/** Gate config — whether to run tests */
	verificationCheckTests: z.boolean().optional(),
	/** Build command (e.g. "npm run build") */
	verificationBuildCommand: z.string().optional(),
	/** Lint command (e.g. "npm run lint") */
	verificationLintCommand: z.string().optional(),
	/** Type check command (e.g. "npm run typecheck") */
	verificationTypeCheckCommand: z.string().optional(),
	/** Test command (e.g. "npm test") */
	verificationTestCommand: z.string().optional(),
	/** Per-gate timeout in ms */
	verificationTimeoutMs: z.number().min(1000).optional(),
})

export type Experiments = z.infer<typeof experimentsSchema>
