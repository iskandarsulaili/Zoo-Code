const mockState = vi.hoisted(() => ({
	stores: [] as any[],
	collectors: [] as any[],
	analyzers: [] as any[],
	appliers: [] as any[],
	adapters: [] as any[],
}))

function createStoreMock() {
	return {
		initialize: vi.fn().mockResolvedValue(undefined),
		persist: vi.fn().mockResolvedValue(undefined),
		reset: vi.fn().mockResolvedValue(undefined),
		getConfig: vi.fn().mockReturnValue({
			reviewOnTurnCount: 10,
			reviewOnToolIterationCount: 2,
			maxPromptPatterns: 5,
			curatorEnabled: true,
			curatorIntervalMs: 5_000,
			staleAfterDays: 14,
			archiveAfterDays: 60,
			codeIndexCorrelationEnabled: true,
		}),
		getPatterns: vi.fn().mockReturnValue([]),
		getRecentEvents: vi.fn().mockReturnValue([]),
		getPendingActions: vi.fn().mockReturnValue([]),
		getTelemetry: vi.fn().mockReturnValue({
			promptEnrichmentUses: 0,
			toolPreferenceUses: 0,
			errorAvoidanceUses: 0,
			skillSuggestionCount: 0,
		}),
		getCounters: vi.fn().mockReturnValue({ userTurnsSinceReview: 0, toolIterationsSinceReview: 0 }),
		addEvent: vi.fn(),
		addPattern: vi.fn(),
		addAction: vi.fn(),
		incrementToolIterations: vi.fn(),
		incrementUserTurns: vi.fn(),
		resetCounters: vi.fn(),
		updateTelemetry: vi.fn(),
		updatePattern: vi.fn(),
		archivePattern: vi.fn(),
	}
}

vi.mock("../LearningStore", () => ({
	LearningStore: vi.fn().mockImplementation(() => {
		const store = createStoreMock()
		mockState.stores.push(store)
		return store
	}),
}))

vi.mock("../FeedbackCollector", () => ({
	FeedbackCollector: vi.fn().mockImplementation(() => {
		const collector = {
			createTaskEvent: vi.fn().mockImplementation((info) => ({
				id: "evt-task",
				signal: info.success ? "TASK_SUCCESS" : "TASK_FAILURE",
				timestamp: 1,
				taskId: info.taskId,
				context: { toolNames: info.toolNames },
				outcome: { success: info.success },
			})),
			createCorrectionEvent: vi.fn().mockReturnValue({
				id: "evt-correction",
				signal: "USER_CORRECTION",
				timestamp: 1,
				context: {},
				outcome: { corrected: true },
			}),
			createCodeIndexEvent: vi.fn().mockReturnValue({
				id: "evt-code-index",
				signal: "CODE_INDEX_HIT",
				timestamp: 1,
				context: {},
				outcome: {},
			}),
		}
		mockState.collectors.push(collector)
		return collector
	}),
}))

vi.mock("../PatternAnalyzer", () => ({
	PatternAnalyzer: vi.fn().mockImplementation(() => {
		const analyzer = { analyze: vi.fn().mockReturnValue([]) }
		mockState.analyzers.push(analyzer)
		return analyzer
	}),
}))

vi.mock("../ImprovementApplier", () => ({
	ImprovementApplier: vi.fn().mockImplementation(() => {
		const applier = {
			generateActions: vi.fn().mockReturnValue([]),
			getPromptContext: vi.fn().mockReturnValue({ entries: [], revision: 0 }),
		}
		mockState.appliers.push(applier)
		return applier
	}),
}))

vi.mock("../CodeIndexAdapter", () => ({
	CodeIndexAdapter: vi.fn().mockImplementation(() => {
		const adapter = { getInfo: vi.fn().mockReturnValue({ available: true, hits: 3, topScore: 0.9 }) }
		mockState.adapters.push(adapter)
		return adapter
	}),
}))

import { SelfImprovingManager } from "../SelfImprovingManager"

describe("SelfImprovingManager", () => {
	let experiments: Record<string, boolean> | undefined
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	const createManager = () =>
		new SelfImprovingManager({
			globalStoragePath: "/tmp/zoo-code-tests",
			logger,
			getExperiments: () => experiments,
			getCodeIndexInfo: () => ({ available: true, hits: 2, topScore: 0.8 }),
		})

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		mockState.stores.length = 0
		mockState.collectors.length = 0
		mockState.analyzers.length = 0
		mockState.appliers.length = 0
		mockState.adapters.length = 0
		experiments = undefined
		logger = { appendLine: vi.fn() }
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("has zero runtime overhead when disabled", async () => {
		const manager = createManager()

		await manager.initialize()
		await manager.recordTaskCompletion({ taskId: "task-1", success: true, toolNames: ["read_file"] })

		expect(mockState.stores).toHaveLength(0)
		expect(vi.getTimerCount()).toBe(0)
		expect(manager.getStatus()).toEqual({
			enabled: false,
			started: false,
			patternCount: 0,
			eventCount: 0,
			actionCount: 0,
		})
	})

	it("initializes store state and schedules timers when enabled", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()

		await manager.initialize()

		expect(mockState.stores).toHaveLength(1)
		expect(mockState.stores[0].initialize).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(2)
		expect(manager.getStatus()).toMatchObject({ enabled: true, started: true })
	})

	it("runs a review cycle from task completion triggers", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()
		await manager.initialize()

		const store = mockState.stores[0]
		const analyzer = mockState.analyzers[0]
		const applier = mockState.appliers[0]
		const pattern = {
			id: "pattern-1",
			patternType: "prompt",
			state: "active",
			summary: "Prefer semantic search before regex search",
			confidenceScore: 0.9,
			frequency: 3,
			successRate: 0.8,
			firstSeenAt: 1,
			lastSeenAt: 1,
			sourceSignals: ["TASK_SUCCESS"],
			context: {},
		}
		const action = {
			id: "action-1",
			actionType: "PROMPT_ENRICHMENT",
			target: "system-prompt",
			payload: {},
			timestamp: 1,
		}

		store.getCounters.mockReturnValue({ userTurnsSinceReview: 0, toolIterationsSinceReview: 2 })
		store.getRecentEvents.mockReturnValue([
			{ id: "evt-1", signal: "TASK_SUCCESS", timestamp: 1, context: {}, outcome: {} },
		])
		store.getPatterns.mockReturnValueOnce([]).mockReturnValue([pattern])
		analyzer.analyze.mockReturnValue([pattern])
		applier.generateActions.mockReturnValue([action])

		await manager.recordTaskCompletion({ taskId: "task-1", success: true, toolNames: ["search_files"] })

		expect(store.addEvent).toHaveBeenCalledTimes(1)
		expect(store.incrementToolIterations).toHaveBeenCalledWith(1)
		expect(analyzer.analyze).toHaveBeenCalledTimes(1)
		expect(store.addPattern).toHaveBeenCalledWith(pattern)
		expect(store.addAction).toHaveBeenCalledWith(action)
		expect(store.persist).toHaveBeenCalled()
	})

	it("formats prompt context and disposes cleanly on experiment disable", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()
		await manager.initialize()

		const applier = mockState.appliers[0]
		applier.getPromptContext.mockReturnValue({
			entries: [{ type: "prompt", summary: "Search relevant code before editing", confidence: 0.8 }],
			revision: 1,
		})

		expect(manager.getPromptContextString()).toBe(
			"\n## Learned Guidance\n- [prompt] Search relevant code before editing\n",
		)

		experiments = { selfImproving: false }
		await manager.handleExperimentChange(false)

		expect(mockState.stores[0].persist).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
		expect(manager.getStatus()).toEqual({
			enabled: false,
			started: false,
			patternCount: 0,
			eventCount: 0,
			actionCount: 0,
		})
	})
})
