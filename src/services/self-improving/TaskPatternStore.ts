import * as fs from "fs/promises"
import * as path from "path"
import crypto from "crypto"

import debounce from "lodash.debounce"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { Logger } from "./types"

/**
 * Outcome of a recorded task.
 */
export type TaskOutcome = "success" | "failure"

/**
 * A single task pattern entry stored across sessions.
 */
export interface TaskPattern {
	/** Unique hash identifying this pattern */
	patternHash: string
	/** Human-readable description of the task */
	taskDescription: string
	/** Tools used during the task */
	toolsUsed: string[]
	/** Approach summary (how the task was accomplished) */
	approach: string
	/** Whether the task succeeded or failed */
	outcome: TaskOutcome
	/** Number of times this pattern has been observed */
	frequency: number
	/** Timestamp of the most recent occurrence (epoch ms) */
	lastUsed: number
}

/**
 * TaskPatternStore — persistent JSON store (one file per workspace)
 * that records task patterns across sessions for similarity matching.
 *
 * Each entry captures what task was done, which tools were used,
 * the approach taken, and whether it succeeded. Over time the store
 * builds a corpus of reusable patterns that TaskSimilarityMatcher
 * can query to suggest approaches for similar future tasks.
 *
 * Persistence uses debounced JSON writes (same pattern as AccumulatedScoreStore)
 * to batch updates and avoid excessive disk I/O.
 */
export class TaskPatternStore {
	private static readonly STORE_FILENAME = "task-patterns.json"

	/** Patterns older than this many days are pruned */
	private static readonly PRUNE_AFTER_DAYS = 60

	/** Debounce interval for persistence (ms) */
	private static readonly DEBOUNCE_MS = 1500

	private readonly filePath: string
	private readonly logger: Logger
	private entries: Map<string, TaskPattern> = new Map()
	private initialized = false
	private initPromise: Promise<void> | null = null
	private readonly debouncedPersist: () => void

	constructor(storageBasePath: string, logger: Logger) {
		this.filePath = path.join(storageBasePath, TaskPatternStore.STORE_FILENAME)
		this.logger = logger
		this.debouncedPersist = debounce(async () => {
			await this.doPersist()
		}, TaskPatternStore.DEBOUNCE_MS)
	}

	/**
	 * Initialize the store — load persisted entries from disk.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		if (!this.initPromise) {
			this.initPromise = this.doInitialize()
		}

		await this.initPromise
	}

	private async doInitialize(): Promise<void> {
		try {
			await this.loadFromDisk()
			this.logger.appendLine(
				`[TaskPatternStore] Initialized: ${this.entries.size} task patterns loaded`,
			)
		} catch (error) {
			this.logger.appendLine(
				`[TaskPatternStore] Initialization error: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.initialized = true
			this.initPromise = null
		}
	}

	/**
	 * Load entries from disk.
	 */
	private async loadFromDisk(): Promise<void> {
		try {
			const raw = await fs.readFile(this.filePath, "utf-8")
			const parsed = JSON.parse(raw)

			if (!Array.isArray(parsed)) {
				return
			}

			for (const candidate of parsed) {
				const entry = this.sanitizeEntry(candidate)
				if (entry) {
					this.entries.set(entry.patternHash, entry)
				}
			}
		} catch (error: unknown) {
			const err = error as NodeJS.ErrnoException
			if (err.code !== "ENOENT") {
				this.logger.appendLine(
					`[TaskPatternStore] Load error: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	/**
	 * Persist entries to disk atomically.
	 */
	private async doPersist(): Promise<void> {
		try {
			await safeWriteJson(this.filePath, Array.from(this.entries.values()), { prettyPrint: true })
		} catch (error) {
			this.logger.appendLine(
				`[TaskPatternStore] Persist error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Flush any pending debounced writes immediately.
	 */
	async flush(): Promise<void> {
		await this.doPersist()
	}

	/**
	 * Validate and sanitize a raw entry from disk.
	 */
	private sanitizeEntry(value: unknown): TaskPattern | null {
		if (!value || typeof value !== "object") {
			return null
		}

		const candidate = value as Partial<TaskPattern>

		if (typeof candidate.patternHash !== "string" || candidate.patternHash.trim().length === 0) {
			return null
		}

		return {
			patternHash: candidate.patternHash,
			taskDescription: typeof candidate.taskDescription === "string" ? candidate.taskDescription : "",
			toolsUsed: Array.isArray(candidate.toolsUsed)
				? candidate.toolsUsed.filter((t): t is string => typeof t === "string")
				: [],
			approach: typeof candidate.approach === "string" ? candidate.approach : "",
			outcome: candidate.outcome === "success" || candidate.outcome === "failure" ? candidate.outcome : "failure",
			frequency: typeof candidate.frequency === "number" && candidate.frequency >= 1 ? Math.floor(candidate.frequency) : 1,
			lastUsed: typeof candidate.lastUsed === "number" ? candidate.lastUsed : Date.now(),
		}
	}

	/**
	 * Compute a deterministic hash for a task description.
	 */
	private computeHash(taskDescription: string, toolsUsed: string[]): string {
		const normalized = taskDescription.toLowerCase().trim()
		const sortedTools = [...toolsUsed].sort()
		const raw = `${normalized}::${sortedTools.join(",")}`
		return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)
	}

	// ──── Public API ────

	/**
	 * Record a task pattern.
	 *
	 * If a similar pattern already exists (matched by hash), its frequency
	 * is incremented and the approach/outcome are updated with the latest
	 * observation. Otherwise a new entry is created.
	 *
	 * @param taskDescription - Human-readable description of the task
	 * @param toolsUsed - Tools used during the task
	 * @param approach - Approach summary
	 * @param outcome - Whether the task succeeded or failed
	 */
	recordTask(
		taskDescription: string,
		toolsUsed: string[],
		approach: string,
		outcome: TaskOutcome,
	): void {
		const hash = this.computeHash(taskDescription, toolsUsed)
		const now = Date.now()
		const existing = this.entries.get(hash)

		if (existing) {
			existing.frequency += 1
			existing.lastUsed = now
			existing.approach = approach
			existing.outcome = outcome
			existing.toolsUsed = [...new Set([...existing.toolsUsed, ...toolsUsed])]
		} else {
			this.entries.set(hash, {
				patternHash: hash,
				taskDescription,
				toolsUsed: [...new Set(toolsUsed)],
				approach,
				outcome,
				frequency: 1,
				lastUsed: now,
			})
		}

		this.debouncedPersist()
	}

	/**
	 * Find similar tasks using keyword overlap matching.
	 *
	 * Compares the task description against stored entries by splitting
	 * both into lowercase keyword sets. Returns entries whose keyword
	 * overlap ratio meets or exceeds the given threshold.
	 *
	 * @param taskDescription - Description to match against
	 * @param threshold - Minimum keyword overlap ratio (0–1, default 0.3)
	 */
	findSimilarTasks(taskDescription: string, threshold: number = 0.3): TaskPattern[] {
		if (taskDescription.trim().length === 0) {
			return []
		}

		const queryTokens = this.tokenize(taskDescription)
		if (queryTokens.length === 0) {
			return []
		}

		const results: Array<{ pattern: TaskPattern; score: number }> = []

		for (const entry of this.entries.values()) {
			const entryTokens = this.tokenize(entry.taskDescription)
			if (entryTokens.length === 0) {
				continue
			}

			const overlap = queryTokens.filter((t) => entryTokens.has(t)).length
			const score = overlap / Math.max(queryTokens.length, entryTokens.size)

			if (score >= threshold) {
				results.push({ pattern: entry, score })
			}
		}

		// Sort by score descending, then by frequency descending
		results.sort((a, b) => {
			const scoreDiff = b.score - a.score
			if (scoreDiff !== 0) {
				return scoreDiff
			}
			return b.pattern.frequency - a.pattern.frequency
		})

		return results.map((r) => r.pattern)
	}

	/**
	 * Get the most frequent task patterns.
	 *
	 * @param limit - Maximum number of patterns to return (default 10)
	 */
	getMostFrequentPatterns(limit: number = 10): TaskPattern[] {
		return Array.from(this.entries.values())
			.sort((a, b) => b.frequency - a.frequency)
			.slice(0, Math.max(1, limit))
	}

	/**
	 * Remove entries older than PRUNE_AFTER_DAYS.
	 * Returns the number of pruned entries.
	 */
	pruneOldPatterns(): number {
		const cutoff = Date.now() - TaskPatternStore.PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000
		let pruned = 0

		for (const [key, entry] of this.entries) {
			if (entry.lastUsed < cutoff) {
				this.entries.delete(key)
				pruned++
			}
		}

		if (pruned > 0) {
			this.logger.appendLine(
				`[TaskPatternStore] Pruned ${pruned} old pattern(s) (older than ${TaskPatternStore.PRUNE_AFTER_DAYS} days)`,
			)
			this.debouncedPersist()
		}

		return pruned
	}

	/**
	 * Get aggregate statistics about the store.
	 */
	getStats(): { totalEntries: number; totalObservations: number; successCount: number; failureCount: number } {
		let totalObservations = 0
		let successCount = 0
		let failureCount = 0

		for (const entry of this.entries.values()) {
			totalObservations += entry.frequency
			if (entry.outcome === "success") {
				successCount += entry.frequency
			} else {
				failureCount += entry.frequency
			}
		}

		return {
			totalEntries: this.entries.size,
			totalObservations,
			successCount,
			failureCount,
		}
	}

	/**
	 * Reset all stored patterns.
	 */
	async reset(): Promise<void> {
		this.entries.clear()
		await this.doPersist()
	}

	/**
	 * Tokenize a string into a set of lowercase keywords for matching.
	 * Strips common stop words and short tokens.
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
