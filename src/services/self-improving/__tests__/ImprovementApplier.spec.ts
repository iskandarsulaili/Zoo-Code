import { ImprovementApplier } from "../ImprovementApplier"
import type { LearnedPattern } from "../types"

function createToolPattern(): LearnedPattern {
	return {
		id: "pattern-tool",
		patternType: "tool",
		state: "active",
		summary: "Effective tool combination: read_file,search_files",
		confidenceScore: 0.82,
		frequency: 4,
		successRate: 0.9,
		firstSeenAt: 1,
		lastSeenAt: 2,
		sourceSignals: ["TASK_SUCCESS"],
		context: {
			toolNames: ["read_file", "search_files"],
			modes: ["code"],
		},
	}
}

describe("ImprovementApplier", () => {
	it("creates agent skill actions for repeated tool workflows", () => {
		const applier = new ImprovementApplier({
			getSkillNames: () => [],
			getSkillProvenance: () => "unknown",
			isAutoSkillsEnabled: () => true,
		})

		const actions = applier.generateActions([createToolPattern()])
		const skillAction = actions.find((action) => action.actionType === "SKILL_CREATE")

		expect(skillAction).toBeDefined()
		expect(skillAction?.payload.skillName).toBe("workflow-read-file-search-files")
		expect(skillAction?.payload.source).toBe("project")
		expect(skillAction?.payload.description).toContain("read_file")
		expect(skillAction?.payload.content).toContain("name: workflow-read-file-search-files")
		expect(skillAction?.payload.content).toContain("`read_file`")
	})

	it("updates existing agent-created workflow skills instead of recreating them", () => {
		const applier = new ImprovementApplier({
			getSkillNames: () => ["workflow-read-file-search-files"],
			getSkillProvenance: () => "agent",
			isAutoSkillsEnabled: () => true,
		})

		const actions = applier.generateActions([createToolPattern()])

		expect(actions.some((action) => action.actionType === "SKILL_UPDATE")).toBe(true)
		expect(actions.some((action) => action.actionType === "SKILL_CREATE")).toBe(false)
	})

	it("does not emit skill mutation actions when auto-skills are disabled", () => {
		const applier = new ImprovementApplier({
			getSkillNames: () => [],
			getSkillProvenance: () => "unknown",
			isAutoSkillsEnabled: () => false,
		})

		const actions = applier.generateActions([createToolPattern()])

		expect(actions.some((action) => action.actionType === "SKILL_CREATE")).toBe(false)
		expect(actions.some((action) => action.actionType === "SKILL_UPDATE")).toBe(false)
	})
})
