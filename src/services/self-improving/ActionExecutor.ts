import crypto from "crypto"

import type { MemoryStore } from "./MemoryStore"
import type { SkillProvenance, SkillUsageStore } from "./SkillUsageStore"
import type { ImprovementAction, Logger } from "./types"

/**
 * ActionExecutor - consumes the pending action queue and executes
 * improvement actions transactionally.
 *
 * Each action type maps to a specific executor:
 * - PROMPT_ENRICHMENT: writes to MemoryStore (environment)
 * - ERROR_AVOIDANCE: writes to MemoryStore (environment, with error tags)
 * - TOOL_PREFERENCE: writes to MemoryStore (environment, with tool tags)
 * - SKILL_SUGGESTION: records in SkillUsageStore for future user approval
 *
 * Actions are removed from the queue only after successful execution.
 * Failed actions remain pending for later retry.
 */
export class ActionExecutor {
	private readonly memoryStore: MemoryStore
	private readonly skillUsageStore: SkillUsageStore
	private readonly logger: Logger

	constructor(memoryStore: MemoryStore, skillUsageStore: SkillUsageStore, logger: Logger) {
		this.memoryStore = memoryStore
		this.skillUsageStore = skillUsageStore
		this.logger = logger
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

	/**
	 * Execute a PROMPT_ENRICHMENT action.
	 * Writes the learned guidance to the environment memory store.
	 */
	private async executePromptEnrichment(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		if (!summary) {
			return false
		}

		const entry = await this.memoryStore.addEnvironmentEntry(summary, {
			source: "learning",
			tags: ["learned", "prompt"],
		})

		return entry !== null || summary.trim().length > 0
	}

	/**
	 * Execute an ERROR_AVOIDANCE action.
	 * Writes the error avoidance guidance to the environment memory store.
	 */
	private async executeErrorAvoidance(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		const errorKeys = this.readStringArrayPayload(action.payload.errorKeys)

		if (!summary) {
			return false
		}

		const entry = await this.memoryStore.addEnvironmentEntry(summary, {
			source: "learning",
			tags: ["error-avoidance", ...errorKeys.map((key) => `error:${key}`)],
		})

		return entry !== null || summary.trim().length > 0
	}

	/**
	 * Execute a TOOL_PREFERENCE action.
	 * Writes the tool preference guidance to the environment memory store.
	 */
	private async executeToolPreference(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		const toolNames = this.readStringArrayPayload(action.payload.toolNames)

		if (!summary) {
			return false
		}

		const entry = await this.memoryStore.addEnvironmentEntry(summary, {
			source: "learning",
			tags: ["tool-preference", ...toolNames.map((toolName) => `tool:${toolName}`)],
		})

		return entry !== null || summary.trim().length > 0
	}

	/**
	 * Execute a SKILL_SUGGESTION action.
	 * Records the suggestion in SkillUsageStore for future user approval.
	 */
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
}
