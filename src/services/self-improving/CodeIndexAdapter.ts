import type { CodeIndexInfo, Logger } from "./types"

/**
 * CodeIndexAdapter - thin read-only adapter for code index integration.
 *
 * When code index is unavailable or disabled, returns a no-op payload
 * and the learning loop proceeds normally.
 */
export class CodeIndexAdapter {
	private readonly getCodeIndexInfo: (() => CodeIndexInfo) | undefined

	constructor(
		private readonly logger?: Logger,
		getCodeIndexInfo?: () => CodeIndexInfo,
	) {
		this.getCodeIndexInfo = getCodeIndexInfo
	}

	/**
	 * Get current code index info.
	 * Returns a safe default if the adapter is not configured.
	 */
	getInfo(): CodeIndexInfo {
		if (!this.getCodeIndexInfo) {
			return { available: false, hits: 0 }
		}

		try {
			return this.getCodeIndexInfo()
		} catch (error) {
			this.logger?.appendLine(
				`[CodeIndexAdapter] Error getting code index info: ${error instanceof Error ? error.message : String(error)}`,
			)
			return { available: false, hits: 0 }
		}
	}

	/**
	 * Check if code index is available and configured.
	 */
	isAvailable(): boolean {
		return this.getInfo().available
	}
}
