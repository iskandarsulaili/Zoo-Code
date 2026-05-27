import crypto from "crypto"

import type { SkillProvenance } from "./SkillUsageStore"
import type { ImprovementAction, LearnedPattern, PromptContext } from "./types"

interface ImprovementApplierOptions {
	getSkillNames?: () => string[]
	getSkillProvenance?: (name: string) => SkillProvenance | string
	getSkillProvenanceForSource?: (name: string, source: "global" | "project") => SkillProvenance | string
	hasSkill?: (name: string, source: "global" | "project") => boolean
	isAutoSkillsEnabled?: () => boolean
	getAutoSkillsScope?: () => "workspace" | "global"
}

/**
 * ImprovementApplier - converts learned patterns into actionable improvements.
 *
 * Generates:
 * - Prompt enrichment context (bounded, ordered by confidence)
 * - Tool preference adjustments
 * - Error avoidance hints
 * - Skill suggestions / mutations for reusable workflows
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
	}

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

	private createSkillMutationAction(pattern: LearnedPattern, now: number): ImprovementAction | undefined {
		const toolNames = this.normalizeToolNames(pattern.context.toolNames)
		if (toolNames.length < 1 || pattern.frequency < 2 || pattern.successRate < 0.5) {
			return undefined
		}

		const skillName = this.buildWorkflowSkillName(toolNames)
		const summary = `Capture reusable workflow for ${toolNames.join(", ")}`
		const description = `Use when tasks repeatedly succeed with ${toolNames.join(" and ")}.`
		const content = this.buildSkillContent(skillName, description, toolNames)
		const modeSlugs =
			pattern.context.modes && pattern.context.modes.length > 0 ? [...new Set(pattern.context.modes)] : undefined
		const source = this.getAutoSkillsScope() === "global" ? "global" : "project"
		const skillExists = this.hasSkill(skillName, source)
		const skillId = this.buildSkillId(skillName, source)

		if (
			skillExists &&
			this.normalizeSkillProvenance(this.getSkillProvenanceForSource(skillName, source)) === "agent"
		) {
			return {
				id: crypto.randomUUID(),
				actionType: "SKILL_UPDATE",
				target: "skills-manager",
				payload: {
					patternId: pattern.id,
					skillId,
					skillName,
					summary,
					description,
					content,
					source,
					mode: modeSlugs?.[0],
					modeSlugs,
					createdBy: "agent",
					confidence: pattern.confidenceScore,
					toolNames,
				},
				timestamp: now,
			}
		}

		if (!skillExists) {
			return {
				id: crypto.randomUUID(),
				actionType: "SKILL_CREATE",
				target: "skills-manager",
				payload: {
					patternId: pattern.id,
					skillId,
					skillName,
					summary,
					description,
					content,
					source,
					modeSlugs,
					createdBy: "agent",
					confidence: pattern.confidenceScore,
					toolNames,
				},
				timestamp: now,
			}
		}

		return undefined
	}

	private normalizeToolNames(toolNames: string[] | undefined): string[] {
		if (!Array.isArray(toolNames)) {
			return []
		}

		return Array.from(
			new Set(toolNames.map((toolName) => toolName.trim()).filter((toolName) => toolName.length > 0)),
		).sort()
	}

	private normalizeSkillProvenance(value: SkillProvenance | string): SkillProvenance {
		return value === "agent" || value === "user" || value === "bundled" || value === "hub" ? value : "unknown"
	}

	private buildWorkflowSkillName(toolNames: string[]): string {
		return `workflow-${toolNames
			.map((toolName) =>
				toolName
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, ""),
			)
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
}
