import crypto from "crypto"

import type { SkillProvenance } from "./SkillUsageStore"
import type { Experiments, ImprovementAction, LearnedPattern, PromptContext } from "./types"
import type { TaskPatternStore } from "./TaskPatternStore"
import type { TaskSimilarityMatcher, TaskMatchResult } from "./TaskSimilarityMatcher"

interface ImprovementApplierOptions {
	getSkillNames?: () => string[]
	getSkillProvenance?: (name: string) => SkillProvenance | string
	getSkillProvenanceForSource?: (name: string, source: "global" | "project") => SkillProvenance | string
	hasSkill?: (name: string, source: "global" | "project") => boolean
	isAutoSkillsEnabled?: () => boolean
	getAutoSkillsScope?: () => "workspace" | "global"
	getExperiments?: () => Experiments | undefined
	taskPatternStore?: TaskPatternStore
	taskSimilarityMatcher?: TaskSimilarityMatcher
}

/**
 * ImprovementApplier - converts learned patterns into actionable improvements.
 *
 * Generates:
 * - Prompt enrichment context (bounded, ordered by confidence)
 * - Tool preference adjustments
 * - Error avoidance hints
 * - Skill suggestions / mutations for reusable workflows
 *
 * Task Pattern Learning (experiment-gated):
 * - Before generating improvements, checks TaskSimilarityMatcher for existing patterns
 * - After generating improvements, records task pattern in TaskPatternStore
 * - If similar pattern exists with high confidence, suggests reusing approach
 */
export class ImprovementApplier {
	private readonly getSkillNames: () => string[]
	private readonly getSkillProvenance: (name: string) => SkillProvenance | string
	private readonly getSkillProvenanceForSource: (
		name: string,
		source: "global" | "project",
	) => SkillProvenance | string
	private readonly hasSkill: (name: string, source: "global" | "project") => boolean
	private readonly isAutoSkillsEnabled: () => boolean
	private readonly getAutoSkillsScope: () => "workspace" | "global"
	private readonly getExperiments: () => Experiments | undefined
	private readonly taskPatternStore: TaskPatternStore | undefined
	private readonly taskSimilarityMatcher: TaskSimilarityMatcher | undefined

	constructor(options: ImprovementApplierOptions = {}) {
		this.getSkillNames = options.getSkillNames ?? (() => [])
		this.getSkillProvenance = options.getSkillProvenance ?? (() => "unknown")
		this.getSkillProvenanceForSource =
			options.getSkillProvenanceForSource ?? ((name: string) => this.getSkillProvenance(name))
		this.hasSkill =
			options.hasSkill ??
			((name: string, source: "global" | "project") =>
				source === "project" && this.getSkillNames().includes(name))
		this.isAutoSkillsEnabled = options.isAutoSkillsEnabled ?? (() => false)
		this.getAutoSkillsScope = options.getAutoSkillsScope ?? (() => "workspace")
		this.getExperiments = options.getExperiments ?? (() => undefined)
		this.taskPatternStore = options.taskPatternStore
		this.taskSimilarityMatcher = options.taskSimilarityMatcher
	}

	/**
	 * Generate improvement actions from learned patterns.
	 * Each active pattern maps to one or more actions.
	 *
	 * If task pattern learning is enabled, checks for similar stored patterns
	 * before generating actions and records the current task after.
	 */
	generateActions(patterns: LearnedPattern[]): ImprovementAction[] {
		const actions: ImprovementAction[] = []
		const now = Date.now()

		// ── Task Pattern Learning: check for similar patterns before generating ──
		const experiments = this.getExperiments()
		if (experiments?.taskPatternLearning !== false && this.taskSimilarityMatcher && this.taskPatternStore) {
			const taskDescription = this.inferTaskDescription(patterns)
			const toolNames = this.collectToolNames(patterns)
			const matchResult = this.taskSimilarityMatcher.match(taskDescription, toolNames)

			if (matchResult.matched && matchResult.pattern) {
				actions.push(this.createPatternReuseAction(matchResult, now))
			}
		}

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
					if (this.isAutoSkillsEnabled()) {
						const skillAction = this.createSkillMutationAction(pattern, now)
						if (skillAction) {
							actions.push(skillAction)
						}
					}
					break
				case "prompt":
					actions.push(this.createPromptEnrichmentAction(pattern, now))
					break
				case "skill":
					actions.push(this.createSkillSuggestionAction(pattern, now))
					break
			}
		}

		// SKILL_MERGE: detect similar skills and generate merge actions
		if (experiments?.selfImprovingSkillMerge !== false) {
			const mergeActions = this.generateSkillMergeActions(patterns, now)
			actions.push(...mergeActions)
		}

		// SPECIALIZED_SKILL: generate SKILL_CREATE_FROM_SCRATCH actions for
		// high-confidence, domain-specific patterns that warrant dedicated skills
		if (experiments?.selfImprovingSpecializedSkills !== false) {
			const specializedActions = this.generateSpecializedSkillActions(patterns, now)
			actions.push(...specializedActions)
		}

		// ── Task Pattern Learning: record current task pattern ──
		if (experiments?.taskPatternLearning !== false && this.taskPatternStore) {
			const taskDescription = this.inferTaskDescription(patterns)
			const toolNames = this.collectToolNames(patterns)
			const approach = this.inferApproach(patterns)
			const outcome = this.inferOutcome(patterns)

			this.taskPatternStore.recordTask(taskDescription, toolNames, approach, outcome)
		}

		return actions
	}

	/**
	 * Build a bounded prompt context from learned patterns.
	 * Returns the top-N patterns by confidence, ordered descending.
	 */
	buildPromptContext(patterns: LearnedPattern[], maxEntries: number = 5): PromptContext {
		const active = patterns.filter((p) => p.state === "active" && p.confidenceScore != null)

		// Sort by confidence descending, take top N
		const top = active.sort((a, b) => (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0)).slice(0, maxEntries)

		return {
			entries: top.map((p) => ({
				type: p.patternType,
				summary: p.summary,
				confidence: p.confidenceScore ?? 0,
			})),
			revision: Date.now(),
		}
	}

	/**
	 * Alias for buildPromptContext — used by SelfImprovingManager.getPromptContext().
	 */
	getPromptContext(patterns: LearnedPattern[], maxEntries: number, revision?: number): PromptContext {
		return this.buildPromptContext(patterns, maxEntries)
	}

	/**
	 * Create a PATTERN_REUSE action when a similar task pattern is found.
	 */
	private createPatternReuseAction(match: TaskMatchResult, now: number): ImprovementAction {
		const pattern = match.pattern!
		return {
			id: crypto.randomUUID(),
			actionType: "PROMPT_ENRICHMENT",
			target: "system-prompt",
			payload: {
				summary: `Similar task detected (confidence: ${(match.confidence * 100).toFixed(0)}%): previous approach used ${pattern.toolsUsed.join(", ")} — ${pattern.approach}`,
				confidence: match.confidence,
				patternId: `task-pattern:${pattern.patternHash}`,
			},
			timestamp: now,
		}
	}

	/**
	 * Infer a task description from the current set of patterns.
	 * Joins summaries of active patterns into a single description.
	 */
	private inferTaskDescription(patterns: LearnedPattern[]): string {
		const active = patterns.filter((p) => p.state === "active")
		if (active.length === 0) {
			return ""
		}

		return active
			.map((p) => p.summary)
			.filter(Boolean)
			.join("; ")
	}

	/**
	 * Collect all unique tool names from active patterns.
	 */
	private collectToolNames(patterns: LearnedPattern[]): string[] {
		const tools = new Set<string>()
		for (const pattern of patterns) {
			if (pattern.state === "active") {
				for (const tool of pattern.context.toolNames ?? []) {
					tools.add(tool)
				}
			}
		}
		return [...tools]
	}

	/**
	 * Infer an approach summary from the current patterns.
	 */
	private inferApproach(patterns: LearnedPattern[]): string {
		const active = patterns.filter((p) => p.state === "active")
		if (active.length === 0) {
			return "No patterns available"
		}

		const parts: string[] = []
		for (const pattern of active) {
			const tools = pattern.context.toolNames ?? []
			const toolStr = tools.length > 0 ? ` using ${tools.join(", ")}` : ""
			parts.push(`${pattern.patternType}: ${pattern.summary}${toolStr}`)
		}

		return parts.join(" | ")
	}

	/**
	 * Infer outcome from patterns — success if no error patterns dominate.
	 */
	private inferOutcome(patterns: LearnedPattern[]): "success" | "failure" {
		const active = patterns.filter((p) => p.state === "active")
		if (active.length === 0) {
			return "success"
		}

		const errorPatterns = active.filter((p) => p.patternType === "error")
		const nonErrorPatterns = active.filter((p) => p.patternType !== "error")

		// If error patterns outnumber non-error, consider it a failure
		if (errorPatterns.length > nonErrorPatterns.length) {
			return "failure"
		}

		return "success"
	}

	private createErrorAvoidanceAction(pattern: LearnedPattern, now: number): ImprovementAction {
		const errorKeys = pattern.context.errorKeys ?? []
		const primaryErrorKey = errorKeys.length > 0 ? errorKeys[0] : "unknown"

		return {
			id: crypto.randomUUID(),
			actionType: "ERROR_AVOIDANCE",
			target: "task-execution",
			payload: {
				summary: pattern.summary,
				errorKeys,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
				primaryErrorKey,
			},
			timestamp: now,
		}
	}

	private createToolPreferenceAction(pattern: LearnedPattern, now: number): ImprovementAction {
		const toolNames = pattern.context.toolNames ?? []
		return {
			id: crypto.randomUUID(),
			actionType: "TOOL_PREFERENCE",
			target: "task-execution",
			payload: {
				summary: pattern.summary,
				toolNames,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
			},
			timestamp: now,
		}
	}

	private createPromptEnrichmentAction(pattern: LearnedPattern, now: number): ImprovementAction {
		return {
			id: crypto.randomUUID(),
			actionType: "PROMPT_ENRICHMENT",
			target: "system-prompt",
			payload: {
				summary: pattern.summary,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
			},
			timestamp: now,
		}
	}

	private createSkillSuggestionAction(pattern: LearnedPattern, now: number): ImprovementAction {
		const toolNames = pattern.context.toolNames ?? []
		const skillName = this.buildWorkflowSkillName(toolNames)
		const summary = `Capture reusable workflow for ${toolNames.join(", ")}`

		return {
			id: crypto.randomUUID(),
			actionType: "SKILL_SUGGESTION",
			target: "review-queue",
			payload: {
				summary,
				skillName,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
			},
			timestamp: now,
		}
	}

	private createSkillMutationAction(pattern: LearnedPattern, now: number): ImprovementAction | undefined {
		const toolNames = pattern.context.toolNames ?? []
		if (toolNames.length === 0) {
			return undefined
		}

		const skillName = this.buildWorkflowSkillName(toolNames)
		const summary = `Auto-created workflow for ${toolNames.join(", ")}`
		const source = this.getAutoSkillsScope() === "global" ? "global" : "project"
		const skillId = this.buildSkillId(skillName, source)

		if (this.hasSkill(skillName, source)) {
			return {
				id: crypto.randomUUID(),
				actionType: "SKILL_UPDATE",
				target: "skills-manager",
				payload: {
					skillName,
					skillId,
					content: this.buildSkillContent(skillName, summary, toolNames),
					source,
					confidence: pattern.confidenceScore ?? 0.5,
					patternId: pattern.id,
				},
				timestamp: now,
			}
		}

		return {
			id: crypto.randomUUID(),
			actionType: "SKILL_CREATE",
			target: "skills-manager",
			payload: {
				skillName,
				skillId,
				description: summary,
				content: this.buildSkillContent(skillName, summary, toolNames),
				source,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
			},
			timestamp: now,
		}
	}

	private buildWorkflowSkillName(toolNames: string[]): string {
		return `workflow-${toolNames
			.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, "-"))
			.sort()
			.join("-")}`
	}

	private buildSkillId(skillName: string, source: "global" | "project"): string {
		return `skill:${source}:${skillName}`
	}

	private buildSkillContent(skillName: string, description: string, toolNames: string[]): string {
		const title = skillName
			.split("-")
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(" ")
		const bulletList = toolNames.map((toolName) => "- `" + toolName + "`").join("\n")
		const inlineTools = toolNames.map((toolName) => "`" + toolName + "`").join(" then ")

		return `---
name: ${skillName}
description: ${description}
---

# ${title}

## When to use

${description}

## Preferred tools

${bulletList}

## Workflow

1. Start with ${inlineTools}.
2. Keep the sequence focused on the same reusable workflow.
3. Update this skill when the workflow changes materially.
`
	}

	/**
	 * Generate SKILL_MERGE actions when similar skills are detected.
	 * Two skills are considered similar if they share significant tool overlap.
	 */
	private generateSkillMergeActions(patterns: LearnedPattern[], now: number): ImprovementAction[] {
		const actions: ImprovementAction[] = []
		const skillPatterns = patterns.filter(
			(p) => p.patternType === "skill" && p.state === "active" && p.frequency >= 2,
		)

		if (skillPatterns.length < 2) {
			return actions
		}

		// Group patterns by tool overlap
		const processed = new Set<string>()
		for (let i = 0; i < skillPatterns.length; i++) {
			if (processed.has(skillPatterns[i].id)) {
				continue
			}

			const toolsA = new Set(skillPatterns[i].context.toolNames ?? [])
			const mergeGroup: LearnedPattern[] = [skillPatterns[i]]
			processed.add(skillPatterns[i].id)

			for (let j = i + 1; j < skillPatterns.length; j++) {
				if (processed.has(skillPatterns[j].id)) {
					continue
				}

				const toolsB = new Set(skillPatterns[j].context.toolNames ?? [])
				const overlap = [...toolsA].filter((t) => toolsB.has(t))

				// Merge if at least 50% tool overlap
				const minSize = Math.min(toolsA.size, toolsB.size)
				if (minSize > 0 && overlap.length / minSize >= 0.5) {
					mergeGroup.push(skillPatterns[j])
					processed.add(skillPatterns[j].id)
				}
			}

			if (mergeGroup.length >= 2) {
				const umbrellaName = this.buildMergeSkillName(mergeGroup)
				const absorbNames = mergeGroup
					.slice(1)
					.map((p) => this.buildWorkflowSkillName(p.context.toolNames ?? []))
				const mergedDescription = `Merged skill combining ${mergeGroup.map((p) => p.summary).join("; ")}`
				const mergedContent = this.buildMergeSkillContent(umbrellaName, mergedDescription, mergeGroup)

				actions.push({
					id: crypto.randomUUID(),
					actionType: "SKILL_MERGE",
					target: "skills-manager",
					payload: {
						umbrellaName,
						absorbNames,
						description: mergedDescription,
						content: mergedContent,
						source: this.getAutoSkillsScope() === "global" ? "global" : "project",
						patternIds: mergeGroup.map((p) => p.id),
						confidence: Math.min(
							1,
							mergeGroup.reduce((sum, p) => sum + (p.confidenceScore ?? 0), 0) / mergeGroup.length,
						),
					},
					timestamp: now,
				})
			}
		}

		return actions
	}

	private buildMergeSkillName(patterns: LearnedPattern[]): string {
		const allTools = new Set<string>()
		for (const pattern of patterns) {
			for (const toolName of pattern.context.toolNames ?? []) {
				allTools.add(toolName)
			}
		}

		return this.buildWorkflowSkillName([...allTools])
	}

	private buildMergeSkillContent(name: string, description: string, patterns: LearnedPattern[]): string {
		const title = name
			.split("-")
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(" ")

		const allTools = new Set<string>()
		for (const pattern of patterns) {
			for (const toolName of pattern.context.toolNames ?? []) {
				allTools.add(toolName)
			}
		}

		const bulletList = [...allTools].map((toolName) => "- `" + toolName + "`").join("\n")
		const inlineTools = [...allTools].map((toolName) => "`" + toolName + "`").join(" then ")

		const patternSummaries = patterns
			.map((p) => `- ${p.summary} (confidence: ${((p.confidenceScore ?? 0) * 100).toFixed(0)}%)`)
			.join("\n")

		return `---
name: ${name}
description: ${description}
---

# ${title}

## Description

${description}

## Merged From

${patternSummaries}

## Preferred Tools

${bulletList}

## Workflow

1. Start with ${inlineTools}.
2. Keep the sequence focused on the same reusable workflow.
3. This skill was automatically merged from similar patterns.
`
	}

	/**
	 * Generate SKILL_CREATE_FROM_SCRATCH actions for high-confidence,
	 * domain-specific patterns that warrant dedicated specialized skills.
	 *
	 * A pattern qualifies for specialization when:
	 * - It has high confidence (>= 0.7) and frequency (>= 3)
	 * - It involves domain-specific tool combinations
	 * - The pattern summary suggests a reusable domain (e.g., "react", "api", "test", "deploy")
	 *
	 * Enhanced with:
	 * - Flexible domain detection via tool usage patterns + task description analysis
	 * - Versatility scoring to measure cross-domain applicability
	 * - Cross-domain applicability notes in skill content
	 * - High-versatility skills promoted to global scope
	 */
	private generateSpecializedSkillActions(patterns: LearnedPattern[], now: number): ImprovementAction[] {
		const actions: ImprovementAction[] = []

		// Only generate when auto-skills are enabled
		if (!this.isAutoSkillsEnabled()) {
			return actions
		}

		const defaultSource = this.getAutoSkillsScope() === "global" ? "global" : "project"

		for (const pattern of patterns) {
			if (pattern.state !== "active") {
				continue
			}

			// Require high confidence and sufficient frequency for specialization
			if ((pattern.confidenceScore ?? 0) < 0.7 || (pattern.frequency ?? 0) < 3) {
				continue
			}

			const toolNames = pattern.context.toolNames ?? []
			if (toolNames.length === 0) {
				continue
			}

			// Detect domain from pattern summary and tool names — flexible approach
			const domainResult = this.detectSpecializedDomain(pattern.summary, toolNames)
			if (!domainResult) {
				continue
			}

			const { domain, crossDomainPatterns } = domainResult

			// Compute versatility score — how broadly applicable this skill is
			const versatilityScore = this.computeVersatilityScore(domain, toolNames, pattern)

			// High-versatility skills should be global; low-versatility stay project-local
			const source = versatilityScore >= 0.7 ? "global" : defaultSource

			const skillName = this.buildSpecializedSkillName(domain, toolNames)
			const skillId = this.buildSkillId(skillName, source)

			// Skip if skill already exists
			if (this.hasSkill(skillName, source)) {
				continue
			}

			const description = `Specialized skill for ${domain}: ${pattern.summary}`
			const instructions = this.buildSpecializedSkillContent(
				skillName,
				description,
				domain,
				toolNames,
				pattern,
				versatilityScore,
				crossDomainPatterns,
			)

			actions.push({
				id: crypto.randomUUID(),
				actionType: "SKILL_CREATE_FROM_SCRATCH",
				target: "skills-manager",
				payload: {
					name: skillName,
					skillId,
					description,
					instructions,
					source,
					modeSlugs: pattern.context.modes ?? [],
					tools: toolNames,
					confidence: pattern.confidenceScore ?? 0.7,
					patternId: pattern.id,
					// New metadata for cross-domain versatility
					domains: this.inferRelatedDomains(domain, toolNames, pattern),
					versatilityScore,
					crossDomainPatterns,
				},
				timestamp: now,
			})
		}

		return actions
	}

	/**
	 * Compute a versatility score (0-1) measuring how broadly applicable
	 * a skill is across different domains.
	 *
	 * Factors:
	 * - Tool diversity: more distinct tools → higher versatility
	 * - Domain generality: generic domains (e.g., "code-review", "documentation")
	 *   score higher than specific ones (e.g., "react-component")
	 * - Pattern frequency: higher frequency suggests broader applicability
	 * - Mode diversity: pattern used across multiple modes → higher versatility
	 */
	private computeVersatilityScore(
		domain: string,
		toolNames: string[],
		pattern: LearnedPattern,
	): number {
		let score = 0.5 // baseline

		// Tool diversity: 0–0.2 bonus for 3+ distinct tools
		const uniqueTools = new Set(toolNames).size
		score += Math.min(0.2, uniqueTools * 0.07)

		// Domain generality: generic domains get a bonus
		const genericDomains = new Set([
			"code-review",
			"documentation",
			"testing",
			"deployment",
			"debugging",
			"refactoring",
			"optimization",
			"configuration",
			"migration",
		])
		if (genericDomains.has(domain)) {
			score += 0.15
		}

		// Frequency bonus: 0–0.1 for patterns with frequency >= 5
		if ((pattern.frequency ?? 0) >= 5) {
			score += 0.1
		}

		// Mode diversity: 0–0.1 for patterns used in 2+ modes
		const modes = pattern.context.modes ?? []
		if (modes.length >= 2) {
			score += 0.1
		}

		return Math.min(1, Math.max(0, score))
	}

	/**
	 * Detect a specialized domain from pattern summary and tool names.
	 * Returns the domain name and any cross-domain patterns found.
	 */
	private detectSpecializedDomain(
		summary: string,
		toolNames: string[],
	): { domain: string; crossDomainPatterns: string[] } | undefined {
		const lowerSummary = summary.toLowerCase()
		const toolSet = new Set(toolNames.map((t) => t.toLowerCase()))

		// Domain detection rules — ordered by specificity
		const domainRules: Array<{ domain: string; keywords: string[]; tools: string[] }> = [
			{
				domain: "react-component",
				keywords: ["react", "component", "jsx", "tsx", "hook", "state"],
				tools: ["read_file", "write_to_file", "apply_diff"],
			},
			{
				domain: "api-endpoint",
				keywords: ["api", "endpoint", "route", "rest", "graphql", "controller"],
				tools: ["read_file", "write_to_file", "execute_command"],
			},
			{
				domain: "database-schema",
				keywords: ["database", "schema", "migration", "table", "query", "sql"],
				tools: ["read_file", "write_to_file", "execute_command"],
			},
			{
				domain: "testing",
				keywords: ["test", "spec", "unit", "integration", "e2e", "coverage"],
				tools: ["read_file", "write_to_file", "execute_command"],
			},
			{
				domain: "deployment",
				keywords: ["deploy", "ci", "cd", "pipeline", "release", "docker"],
				tools: ["read_file", "execute_command"],
			},
			{
				domain: "code-review",
				keywords: ["review", "refactor", "clean", "lint", "format"],
				tools: ["read_file", "search_files", "codebase_search"],
			},
			{
				domain: "documentation",
				keywords: ["document", "readme", "docs", "comment", "api-doc"],
				tools: ["read_file", "write_to_file"],
			},
			{
				domain: "debugging",
				keywords: ["debug", "fix", "bug", "error", "issue", "broken"],
				tools: ["read_file", "search_files", "execute_command"],
			},
		]

		// First pass: prefer keyword matches (more specific signal)
		for (const rule of domainRules) {
			const keywordMatch = rule.keywords.some((kw) => lowerSummary.includes(kw))

			if (keywordMatch) {
				const crossDomainPatterns = domainRules
					.filter((r) => r.domain !== rule.domain)
					.filter((r) => r.keywords.some((kw) => lowerSummary.includes(kw)))
					.map((r) => r.domain)

				return { domain: rule.domain, crossDomainPatterns }
			}
		}

		// Second pass: fall back to tool-based matching (less specific)
		for (const rule of domainRules) {
			const toolMatch = rule.tools.some((t) => toolSet.has(t))

			if (toolMatch) {
				return { domain: rule.domain, crossDomainPatterns: [] }
			}
		}

		return undefined
	}

	/**
	 * Build a specialized skill name from domain and tools.
	 */
	private buildSpecializedSkillName(domain: string, toolNames: string[]): string {
		const toolSuffix = toolNames
			.map((t) => t.replace(/[^a-z0-9]/gi, "-").toLowerCase())
			.slice(0, 2)
			.join("-")
		return `specialized-${domain}-${toolSuffix}`
	}

	/**
	 * Build specialized skill content with domain-specific instructions.
	 */
	private buildSpecializedSkillContent(
		skillName: string,
		description: string,
		domain: string,
		toolNames: string[],
		pattern: LearnedPattern,
		versatilityScore: number,
		crossDomainPatterns: string[],
	): string {
		const title = skillName
			.split("-")
			.map((s) => s.charAt(0).toUpperCase() + s.slice(1))
			.join(" ")

		const toolList = toolNames.map((t) => `- \`${t}\``).join("\n")
		const crossDomainSection =
			crossDomainPatterns.length > 0
				? `\n## Cross-Domain Applicability\n\nThis skill may also apply to: ${crossDomainPatterns.join(", ")}\n`
				: ""

		return `---
name: ${skillName}
description: ${description}
versatility: ${(versatilityScore * 100).toFixed(0)}%
domain: ${domain}
---

# ${title}

## Description

${description}

## Domain

${domain}

## Preferred Tools

${toolList}
${crossDomainSection}
## Usage Notes

- This is a specialized skill for ${domain} tasks.
- Pattern confidence: ${((pattern.confidenceScore ?? 0) * 100).toFixed(0)}%
- Versatility: ${(versatilityScore * 100).toFixed(0)}%
- Frequency: ${pattern.frequency ?? 0} observations
`
	}

	/**
	 * Infer related domains from tool usage and pattern context.
	 */
	private inferRelatedDomains(
		domain: string,
		toolNames: string[],
		pattern: LearnedPattern,
	): string[] {
		const related: string[] = []
		const toolSet = new Set(toolNames.map((t) => t.toLowerCase()))

		// Map tools to potential domains
		if (toolSet.has("execute_command")) {
			related.push("automation")
		}
		if (toolSet.has("search_files") || toolSet.has("codebase_search")) {
			related.push("code-analysis")
		}
		if (toolSet.has("write_to_file") || toolSet.has("apply_diff")) {
			related.push("code-generation")
		}

		// Add modes as related domains
		const modes = pattern.context.modes ?? []
		for (const mode of modes) {
			if (!related.includes(mode)) {
				related.push(mode)
			}
		}

		return related
	}
}
