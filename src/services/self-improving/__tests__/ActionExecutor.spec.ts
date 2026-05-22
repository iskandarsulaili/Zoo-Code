import { ActionExecutor } from "../ActionExecutor"
import type { ImprovementAction } from "../types"

describe("ActionExecutor", () => {
	const logger = { appendLine: vi.fn() }

	beforeEach(() => {
		logger.appendLine.mockReset()
	})

	it("writes prompt, error, and tool guidance into memory", async () => {
		const memoryStore = {
			addEnvironmentEntry: vi.fn().mockResolvedValue({ id: "mem-1" }),
		} as any
		const skillUsageStore = { getOrCreate: vi.fn() } as any
		const executor = new ActionExecutor(memoryStore, skillUsageStore, logger)

		const actions: ImprovementAction[] = [
			{
				id: "action-1",
				actionType: "PROMPT_ENRICHMENT",
				target: "system-prompt",
				payload: { summary: "Prefer semantic search before regex search" },
				timestamp: 1,
			},
			{
				id: "action-2",
				actionType: "ERROR_AVOIDANCE",
				target: "task-execution",
				payload: { summary: "Handle ENOENT before retry", errorKeys: ["ENOENT"] },
				timestamp: 2,
			},
			{
				id: "action-3",
				actionType: "TOOL_PREFERENCE",
				target: "task-execution",
				payload: { summary: "Use codebase_search before search_files", toolNames: ["codebase_search"] },
				timestamp: 3,
			},
		]

		const succeeded = await executor.executeBatch(actions)

		expect(succeeded).toEqual(new Set(["action-1", "action-2", "action-3"]))
		expect(memoryStore.addEnvironmentEntry).toHaveBeenNthCalledWith(
			1,
			"Prefer semantic search before regex search",
			{
				source: "learning",
				tags: ["learned", "prompt"],
			},
		)
		expect(memoryStore.addEnvironmentEntry).toHaveBeenNthCalledWith(2, "Handle ENOENT before retry", {
			source: "learning",
			tags: ["error-avoidance", "error:ENOENT"],
		})
		expect(memoryStore.addEnvironmentEntry).toHaveBeenNthCalledWith(3, "Use codebase_search before search_files", {
			source: "learning",
			tags: ["tool-preference", "tool:codebase_search"],
		})
	})

	it("records skill suggestions in the telemetry sidecar", async () => {
		const memoryStore = { addEnvironmentEntry: vi.fn() } as any
		const skillUsageStore = { getOrCreate: vi.fn() } as any
		const executor = new ActionExecutor(memoryStore, skillUsageStore, logger)

		const action: ImprovementAction = {
			id: "action-skill",
			actionType: "SKILL_SUGGESTION",
			target: "skills-manager",
			payload: {
				summary: "Create a self-improving review skill",
				skillName: "Self Improving Review Skill",
			},
			timestamp: 1,
		}

		await expect(executor.execute(action)).resolves.toBe(true)
		expect(skillUsageStore.getOrCreate).toHaveBeenCalledWith(
			expect.stringMatching(/^suggested:/),
			"Self Improving Review Skill",
			"agent",
		)
		expect(logger.appendLine).toHaveBeenCalledWith(
			"[ActionExecutor] Skill suggestion recorded: Create a self-improving review skill",
		)
	})

	it("keeps invalid actions pending by reporting failure", async () => {
		const executor = new ActionExecutor(
			{ addEnvironmentEntry: vi.fn() } as any,
			{ getOrCreate: vi.fn() } as any,
			logger,
		)

		await expect(
			executor.execute({
				id: "invalid",
				actionType: "PROMPT_ENRICHMENT",
				target: "system-prompt",
				payload: {},
				timestamp: 1,
			}),
		).resolves.toBe(false)
	})
})
