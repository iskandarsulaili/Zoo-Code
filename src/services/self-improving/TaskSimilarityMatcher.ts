import type { TaskPattern, TaskPatternStore } from "./TaskPatternStore"

/**
 * Result of matching a task against stored patterns.
 */
export interface TaskMatchResult {
	/** Whether a sufficiently similar pattern was found */
	matched: boolean
	/** The best-matching pattern (undefined if no match) */
	pattern: TaskPattern | undefined
	/** Confidence score for the match (0–1) */
	confidence: number
}

/**
 * TaskSimilarityMatcher — matches current task descriptions against
 * stored task patterns to detect repetitive/similar tasks.
 *
 * Uses a two-factor scoring approach:
 * 1. Keyword overlap between task descriptions (from TaskPatternStore.findSimilarTasks)
 * 2. Tool usage similarity (Jaccard index on tool sets)
 *
 * The combined score is weighted: 60% keyword overlap, 40% tool similarity.
 * A match is returned when the combined score meets or exceeds the threshold (default 0.7).
 */
export class TaskSimilarityMatcher {
	/** Default confidence threshold for auto-reuse (0.7) */
	private static readonly DEFAULT_THRESHOLD = 0.7

	/** Weight for keyword overlap in combined score */
	private static readonly KEYWORD_WEIGHT = 0.6

	/** Weight for tool similarity in combined score */
	private static readonly TOOL_WEIGHT = 0.4

	private readonly patternStore: TaskPatternStore

	constructor(patternStore: TaskPatternStore) {
		this.patternStore = patternStore
	}

	/**
	 * Match a task description and tool set against stored patterns.
	 *
	 * @param taskDescription - Description of the current task
	 * @param toolsUsed - Tools used in the current task
	 * @param threshold - Minimum confidence for a match (default 0.7)
	 * @returns The best match result
	 */
	match(
		taskDescription: string,
		toolsUsed: string[],
		threshold: number = TaskSimilarityMatcher.DEFAULT_THRESHOLD,
	): TaskMatchResult {
		if (taskDescription.trim().length === 0) {
			return { matched: false, pattern: undefined, confidence: 0 }
		}

		// Step 1: Find candidates by keyword overlap
		const candidates = this.patternStore.findSimilarTasks(taskDescription, 0.2)

		if (candidates.length === 0) {
			return { matched: false, pattern: undefined, confidence: 0 }
		}

		// Step 2: Score each candidate with combined keyword + tool similarity
		const scored: Array<{ pattern: TaskPattern; combinedScore: number }> = []

		for (const candidate of candidates) {
			const keywordScore = this.computeKeywordScore(taskDescription, candidate.taskDescription)
			const toolScore = this.computeToolSimilarity(toolsUsed, candidate.toolsUsed)
			const combinedScore = keywordScore * TaskSimilarityMatcher.KEYWORD_WEIGHT
				+ toolScore * TaskSimilarityMatcher.TOOL_WEIGHT

			scored.push({ pattern: candidate, combinedScore })
		}

		// Step 3: Pick the best match
		scored.sort((a, b) => b.combinedScore - a.combinedScore)
		const best = scored[0]

		if (best.combinedScore >= threshold) {
			return {
				matched: true,
				pattern: best.pattern,
				confidence: best.combinedScore,
			}
		}

		return {
			matched: false,
			pattern: best.pattern,
			confidence: best.combinedScore,
		}
	}

	/**
	 * Compute keyword overlap score between two descriptions.
	 * Uses Jaccard similarity on token sets.
	 */
	private computeKeywordScore(descriptionA: string, descriptionB: string): number {
		const tokensA = this.tokenize(descriptionA)
		const tokensB = this.tokenize(descriptionB)

		if (tokensA.size === 0 && tokensB.size === 0) {
			return 1
		}

		if (tokensA.size === 0 || tokensB.size === 0) {
			return 0
		}

		const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)))
		const union = new Set([...tokensA, ...tokensB])

		return intersection.size / union.size
	}

	/**
	 * Compute Jaccard similarity between two tool sets.
	 */
	private computeToolSimilarity(toolsA: string[], toolsB: string[]): number {
		const setA = new Set(toolsA)
		const setB = new Set(toolsB)

		if (setA.size === 0 && setB.size === 0) {
			return 1
		}

		if (setA.size === 0 || setB.size === 0) {
			return 0
		}

		const intersection = new Set([...setA].filter((t) => setB.has(t)))
		const union = new Set([...setA, ...setB])

		return intersection.size / union.size
	}

	/**
	 * Tokenize a string into a set of lowercase keywords.
	 * Mirrors the tokenization in TaskPatternStore for consistency.
	 */
	private tokenize(text: string): Set<string> {
		const stopWords = new Set([
			"a", "an", "the", "is", "it", "to", "for", "of", "in", "on", "and", "or",
			"with", "at", "by", "from", "as", "be", "this", "that", "are", "was", "were",
			"been", "being", "have", "has", "had", "do", "does", "did", "will", "would",
			"can", "could", "should", "may", "might", "shall", "not", "no", "nor",
			"but", "if", "so", "up", "out", "about", "into", "over", "after", "before",
			"between", "under", "again", "further", "then", "once", "here", "there",
			"when", "where", "why", "how", "all", "each", "every", "both", "few", "more",
			"most", "other", "some", "such", "only", "own", "same", "too", "very",
			"just", "also", "now", "than", "then", "these", "those", "i", "me", "my",
			"myself", "we", "our", "ours", "ourselves", "you", "your", "yours",
			"yourself", "yourselves", "he", "him", "his", "himself", "she", "her",
			"hers", "herself", "they", "them", "their", "theirs", "themselves",
			"please", "need", "want", "make", "get", "set", "use", "create", "implement",
		])

		const tokens = text
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length >= 3 && !stopWords.has(t))

		return new Set(tokens)
	}
}
