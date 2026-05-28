import crypto from "crypto"

import type { MemoryBackend } from "./MemoryBackend"
import type { SkillProvenance, SkillUsageStore } from "./SkillUsageStore"
import type { ImprovementAction, Logger } from "./types"

interface SkillMutationManager {
	createSkillFromContent(
		name: string,
		source: "global" | "project",
		description: string,
		content: string,
		modeSlugs?: string[],
	): Promise<string>
	updateSkillContent(name: string, source: "global" | "project", content: string, mode?: string): Promise<void>
	getSkillContent?(name: string, currentMode?: string): Promise<{ instructions: string } | null>
}

/**
 * ActionExecutor - consumes the pending action queue and executes
 * improvement actions transactionally.
 *
 * Each action type maps to a specific executor:
 * - PROMPT_ENRICHMENT: writes to MemoryStore (environment)
 * - ERROR_AVOIDANCE: writes to MemoryStore (environment, with error tags)
 * - TOOL_PREFERENCE: writes to MemoryStore (environment, with tool tags)
 * - SKILL_SUGGESTION: records in SkillUsageStore for future user approval
 * - SKILL_CREATE / SKILL_UPDATE: safely mutate agent-managed skills via SkillsManager
 *
 * Actions are removed from the queue only after successful execution.
 * Failed actions remain pending for later retry.
 */
export class ActionExecutor {
	private readonly memoryStore: MemoryBackend
	private readonly skillUsageStore: SkillUsageStore
	private readonly logger: Logger
	private readonly skillsManager?: SkillMutationManager

	constructor(
		memoryStore: MemoryBackend,
		skillUsageStore: SkillUsageStore,
		logger: Logger,
		skillsManager?: SkillMutationManager,
	) {
		this.memoryStore = memoryStore
		this.skillUsageStore = skillUsageStore
		this.logger = logger
		this.skillsManager = skillsManager
	}

	/**
	 * Execute a single improvement action.
	 * Returns true if the action was executed successfully.
	 */
	async execute(action: ImprovementAction): Promise<boolean> {
		try {
			let executed = false

			switch (action.actionType) {
				case "PROMPT_ENRICHMENT":
					executed = await this.executePromptEnrichment(action)
					break
				case "ERROR_AVOIDANCE":
					executed = await this.executeErrorAvoidance(action)
					break
				case "TOOL_PREFERENCE":
					executed = await this.executeToolPreference(action)
					break
				case "SKILL_SUGGESTION":
					executed = await this.executeSkillSuggestion(action)
					break
				case "SKILL_CREATE":
					executed = await this.executeSkillCreate(action)
					break
				case "SKILL_UPDATE":
					executed = await this.executeSkillUpdate(action)
					break
				case "SKILL_MERGE":
					executed = await this.executeSkillMerge(action)
					break
				default:
					this.logger.appendLine(`[ActionExecutor] Unknown action type: ${action.actionType}`)
					return false
			}

			this.logger.appendLine(
				`[ActionExecutor] ${executed ? "Executed" : "Deferred"} ${action.actionType} action ${action.id}`,
			)

			return executed
		} catch (error) {
			this.logger.appendLine(
				`[ActionExecutor] Execution error for ${action.id}: ${error instanceof Error ? error.message : String(error)}`,
			)
			return false
		}
	}

	/**
	 * Execute a batch of actions.
	 * Returns the set of successfully executed action IDs.
	 */
	async executeBatch(actions: ImprovementAction[]): Promise<Set<string>> {
		const succeeded = new Set<string>()

		for (const action of actions) {
			const ok = await this.execute(action)
			if (ok) {
				succeeded.add(action.id)
			}
		}

		return succeeded
	}

	private async executePromptEnrichment(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		if (!summary) {
			return false
		}

		await this.memoryStore.store({
			content: summary,
			source: "learning",
			tags: ["learned", "prompt"],
		})

		return true
	}

	private async executeErrorAvoidance(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		const errorKeys = this.readStringArrayPayload(action.payload.errorKeys)

		if (!summary) {
			return false
		}

		await this.memoryStore.store({
			content: summary,
			source: "learning",
			tags: ["error-avoidance", ...errorKeys.map((key) => `error:${key}`)],
		})

		return true
	}

	private async executeToolPreference(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		const toolNames = this.readStringArrayPayload(action.payload.toolNames)

		if (!summary) {
			return false
		}

		await this.memoryStore.store({
			content: summary,
			source: "learning",
			tags: ["tool-preference", ...toolNames.map((toolName) => `tool:${toolName}`)],
		})

		return true
	}

	private async executeSkillSuggestion(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		if (!summary) {
			return false
		}

		const skillName = this.readStringPayload(action.payload.skillName) ?? summary
		const skillId =
			this.readStringPayload(action.payload.skillId) ??
			`suggested:${crypto.createHash("sha256").update(skillName.toLowerCase()).digest("hex").slice(0, 16)}`
		const createdBy = this.readSkillProvenance(action.payload.createdBy) ?? "agent"

		this.skillUsageStore.getOrCreate(skillId, skillName, createdBy)
		this.logger.appendLine(`[ActionExecutor] Skill suggestion recorded: ${summary}`)

		return true
	}

	private async executeSkillCreate(action: ImprovementAction): Promise<boolean> {
		if (!this.skillsManager) {
			this.logger.appendLine("[ActionExecutor] skillsManager not available — deferring SKILL_CREATE")
			return false
		}

		const skillName = this.readStringPayload(action.payload.skillName)
		const description = this.readStringPayload(action.payload.description)
		const content = this.readStringPayload(action.payload.content)
		const source = this.readSkillSource(action.payload.source)
		const modeSlugs = this.readStringArrayPayload(action.payload.modeSlugs)
		const skillId = this.readStringPayload(action.payload.skillId) ?? this.buildSkillId(skillName, source)
		const createdBy = this.readSkillProvenance(action.payload.createdBy) ?? "agent"

		if (!skillName || !description || !content || !source || !skillId) {
			return false
		}

		await this.skillsManager.createSkillFromContent(skillName, source, description, content, modeSlugs)
		this.skillUsageStore.getOrCreate(skillId, skillName, createdBy)
		this.logger.appendLine(`[ActionExecutor] Skill created: ${skillName}`)
		return true
	}

	private async executeSkillUpdate(action: ImprovementAction): Promise<boolean> {
		if (!this.skillsManager) {
			return false
		}

		const skillName = this.readStringPayload(action.payload.skillName)
		const content = this.readStringPayload(action.payload.content)
		const source = this.readSkillSource(action.payload.source)
		const mode = this.readStringPayload(action.payload.mode)
		const skillId = this.readStringPayload(action.payload.skillId) ?? this.buildSkillId(skillName, source)

		if (!skillName || !content || !source || !skillId) {
			return false
		}

		// Deduplication check: skip update if skill content hasn't changed
		if (this.skillsManager.getSkillContent) {
			try {
				const existing = await this.skillsManager.getSkillContent(skillName, mode)
				if (existing && existing.instructions.trim() === content.trim()) {
					this.logger.appendLine(`[ActionExecutor] Skill content unchanged for ${skillName}, skipping update`)
					return false
				}
			} catch {
				// If we can't read the existing content, proceed with update
				this.logger.appendLine(
					`[ActionExecutor] Could not read existing skill content for ${skillName}, proceeding with update`,
				)
			}
		}

		await this.skillsManager.updateSkillContent(skillName, source, content, mode)
		this.skillUsageStore.getOrCreate(skillId, skillName, "agent")
		await this.skillUsageStore.bumpPatch(skillId)
		this.logger.appendLine(`[ActionExecutor] Skill updated: ${skillName}`)
		return true
	}

	private async executeSkillMerge(action: ImprovementAction): Promise<boolean> {
		const umbrellaName = this.readStringPayload(action.payload.umbrellaName)
		const absorbNamesRaw = action.payload.absorbNames
		const absorbNames: string[] = Array.isArray(absorbNamesRaw)
			? absorbNamesRaw.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
			: []
		const newContent = this.readStringPayload(action.payload.content)

		if (!umbrellaName || absorbNames.length === 0) {
			return false
		}

		// 1. Create or update the umbrella skill
		if (newContent) {
			const source = this.readSkillSource(action.payload.source) ?? "global"
			const skillId = `skill:${source}:${umbrellaName}`
			const description =
				this.readStringPayload(action.payload.description) ?? `Umbrella skill merging ${absorbNames.join(", ")}`
			const modeSlugs = this.readStringArrayPayload(action.payload.modeSlugs)

			if (this.skillsManager) {
				const existing = this.skillUsageStore.get(skillId)
				if (existing) {
					await this.skillsManager.updateSkillContent(umbrellaName, source, newContent, modeSlugs[0])
					await this.skillUsageStore.bumpPatch(skillId)
				} else {
					await this.skillsManager.createSkillFromContent(
						umbrellaName,
						source,
						description,
						newContent,
						modeSlugs,
					)
					this.skillUsageStore.getOrCreate(skillId, umbrellaName, "agent")
				}
			} else {
				this.skillUsageStore.getOrCreate(skillId, umbrellaName, "agent")
			}
		}

		// 2. Mark each absorbed skill
		for (const absorbName of absorbNames) {
			const source = this.readSkillSource(action.payload.source) ?? "global"
			const absorbId = `skill:${source}:${absorbName}`
			this.skillUsageStore.setAbsorbedInto(absorbId, umbrellaName)
			await this.skillUsageStore.transitionState(absorbId, "archived")
			this.logger.appendLine(`[ActionExecutor] Merged ${absorbName} into ${umbrellaName}`)
		}

		this.logger.appendLine(`[ActionExecutor] Merge complete: ${absorbNames.length} skills → ${umbrellaName}`)
		return true
	}

	private readStringPayload(value: unknown): string | undefined {
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	private readStringArrayPayload(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return []
		}

		return Array.from(
			new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)),
		)
	}

	private readSkillProvenance(value: unknown): SkillProvenance | undefined {
		return value === "agent" || value === "user" || value === "bundled" || value === "hub" || value === "unknown"
			? value
			: undefined
	}

	private readSkillSource(value: unknown): "global" | "project" | undefined {
		return value === "global" || value === "project" ? value : undefined
	}

	private buildSkillId(skillName: string | undefined, source: "global" | "project" | undefined): string | undefined {
		return skillName && source ? `skill:${source}:${skillName}` : undefined
	}
}
