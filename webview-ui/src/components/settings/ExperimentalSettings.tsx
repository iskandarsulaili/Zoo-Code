import { HTMLAttributes } from "react"

import type { Experiments, ImageGenerationProvider } from "@roo-code/types"

import { EXPERIMENT_IDS, experimentConfigsMap } from "@roo/experiments"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui"
import { cn } from "@src/lib/utils"

import { SetExperimentEnabled } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { ExperimentalFeature } from "./ExperimentalFeature"
import { ImageGenerationSettings } from "./ImageGenerationSettings"
import { CustomToolsSettings } from "./CustomToolsSettings"
import { SelfImprovingStatus } from "./SelfImprovingStatus"

type ExperimentalSettingsProps = HTMLAttributes<HTMLDivElement> & {
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
	apiConfiguration?: any
	setApiConfigurationField?: any
	imageGenerationProvider?: ImageGenerationProvider
	openRouterImageApiKey?: string
	openRouterImageGenerationSelectedModel?: string
	memoryBackend?: "builtin" | "agentmemory"
	agentMemoryUrl?: string
	selfImprovingScope?: "workspace" | "global"
	selfImprovingAutoSkillsScope?: "workspace" | "global"
	setImageGenerationProvider?: (provider: ImageGenerationProvider) => void
	setOpenRouterImageApiKey?: (apiKey: string) => void
	setImageGenerationSelectedModel?: (model: string) => void
	setMemoryBackend?: (backend: "builtin" | "agentmemory") => void
	setAgentMemoryUrl?: (url: string) => void
	setSelfImprovingScope?: (scope: "workspace" | "global") => void
	setSelfImprovingAutoSkillsScope?: (scope: "workspace" | "global") => void
	setLenientModes?: (modes: string[]) => void
	verificationLevel?: "strict" | "lenient" | "bypass"
	setVerificationLevel?: (level: "strict" | "lenient" | "bypass") => void
}

// ── Category definitions ──────────────────────────────────────────────
type ExperimentCategory = {
	key: string
	labelKey: string
	descriptionKey: string
	experimentKeys: string[]
}

const CATEGORIES: ExperimentCategory[] = [
	{
		key: "selfImproving",
		labelKey: "settings:experimental.categories.selfImproving",
		descriptionKey: "settings:experimental.categories.selfImprovingDescription",
		experimentKeys: [
			"SELF_IMPROVING",
			"SELF_IMPROVING_AUTO_SKILLS",
			"SELF_IMPROVING_AUTO_MODE",
			"SELF_IMPROVING_REVIEW_TEAM",
			"SELF_IMPROVING_FULL_TRUST",
			"SELF_IMPROVING_QUESTION_EVALUATION",
			"SELF_IMPROVING_PROMPT_QUALITY",
			"SELF_IMPROVING_TOOL_PREFERENCE",
			"SELF_IMPROVING_SKILL_MERGE",
			"SELF_IMPROVING_PERSIST_COUNTS",
			"SELF_IMPROVING_CODE_INDEX",
			"ONE_SHOT_ORCHESTRATOR",
			"KAIZEN_ORCHESTRATOR",
		],
	},
	{
		key: "verification",
		labelKey: "settings:experimental.categories.verification",
		descriptionKey: "settings:experimental.categories.verificationDescription",
		experimentKeys: ["VERIFICATION_ENGINE", "REQUIREMENTS_VERIFICATION"],
	},
	{
		key: "memory",
		labelKey: "settings:experimental.categories.memory",
		descriptionKey: "settings:experimental.categories.memoryDescription",
		experimentKeys: [],
	},
	{
		key: "infrastructure",
		labelKey: "settings:experimental.categories.infrastructure",
		descriptionKey: "settings:experimental.categories.infrastructureDescription",
		experimentKeys: [
			"PREVENTION_ENGINE",
			"CASCADE_TRACKER",
			"RESILIENCE_SERVICE",
			"TOOL_ERROR_HEALER",
		],
	},
	{
		key: "ui",
		labelKey: "settings:experimental.categories.ui",
		descriptionKey: "settings:experimental.categories.uiDescription",
		experimentKeys: [
			"DIFF_STRATEGY_UNIFIED",
			"INSERT_BLOCK",
			"MULTI_SEARCH_AND_REPLACE",
			"PREVENT_FOCUS_DISRUPTION",
			"ASSISTANT_MESSAGE_PARSER",
			"NEW_TASK_REQUIRE_TODOS",
		],
	},
	{
		key: "tools",
		labelKey: "settings:experimental.categories.tools",
		descriptionKey: "settings:experimental.categories.toolsDescription",
		experimentKeys: [
			"IMAGE_GENERATION",
			"CUSTOM_TOOLS",
			"MARKETPLACE",
			"RUN_SLASH_COMMAND",
			"CONCURRENT_FILE_READS",
		],
	},
]

// Experiments that are handled inline (not rendered via the generic loop)
const INLINE_KEYS = new Set([
	"SELF_IMPROVING",
	"SELF_IMPROVING_AUTO_SKILLS",
	"SELF_IMPROVING_AUTO_MODE",
	"SELF_IMPROVING_REVIEW_TEAM",
	"SELF_IMPROVING_FULL_TRUST",
	"SELF_IMPROVING_QUESTION_EVALUATION",
	"SELF_IMPROVING_PROMPT_QUALITY",
	"SELF_IMPROVING_TOOL_PREFERENCE",
	"SELF_IMPROVING_SKILL_MERGE",
	"SELF_IMPROVING_PERSIST_COUNTS",
	"SELF_IMPROVING_CODE_INDEX",
	"ONE_SHOT_ORCHESTRATOR",
	"KAIZEN_ORCHESTRATOR",
	"PREVENTION_ENGINE",
	"CASCADE_TRACKER",
	"RESILIENCE_SERVICE",
	"TOOL_ERROR_HEALER",
	"VERIFICATION_ENGINE",
	"REQUIREMENTS_VERIFICATION",
	"IMAGE_GENERATION",
	"CUSTOM_TOOLS",
])

// ── Sub-components ────────────────────────────────────────────────────

/** Renders a simple toggle experiment from the config map. */
const SimpleExperimentToggle = ({
	experimentKey,
	experiments,
	setExperimentEnabled,
}: {
	experimentKey: string
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
}) => {
	const { t } = useAppTranslation()
	const config = experimentConfigsMap[experimentKey as keyof typeof experimentConfigsMap]
	if (!config) return null

	const label = t(`settings:experimental.${experimentKey}.name`)
	const enabled =
		experiments[EXPERIMENT_IDS[experimentKey as keyof typeof EXPERIMENT_IDS]] ?? false

	return (
		<SearchableSetting
			settingId={`experimental-${experimentKey.toLowerCase()}`}
			section="experimental"
			label={label}>
			<ExperimentalFeature
				experimentKey={experimentKey}
				enabled={enabled}
				onChange={(enabled) =>
					setExperimentEnabled(
						EXPERIMENT_IDS[experimentKey as keyof typeof EXPERIMENT_IDS],
						enabled,
					)
				}
			/>
		</SearchableSetting>
	)
}

/** Renders the self-improving section with its nested sub-options. */
const SelfImprovingSection = ({
	experiments,
	setExperimentEnabled,
	selfImprovingScope,
	setSelfImprovingScope,
	selfImprovingAutoSkillsScope,
	setSelfImprovingAutoSkillsScope,
	memoryBackend,
	setMemoryBackend,
	agentMemoryUrl,
	setAgentMemoryUrl,
}: {
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
	selfImprovingScope?: "workspace" | "global"
	setSelfImprovingScope?: (scope: "workspace" | "global") => void
	selfImprovingAutoSkillsScope?: "workspace" | "global"
	setSelfImprovingAutoSkillsScope?: (scope: "workspace" | "global") => void
	memoryBackend?: "builtin" | "agentmemory"
	setMemoryBackend?: (backend: "builtin" | "agentmemory") => void
	agentMemoryUrl?: string
	setAgentMemoryUrl?: (url: string) => void
}) => {
	const { t } = useAppTranslation()
	const autoSkillsVisible = experiments[EXPERIMENT_IDS.SELF_IMPROVING] ?? false
	const autoSkillsEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_AUTO_SKILLS] ?? false
	const autoModeEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_AUTO_MODE] ?? false
	const reviewTeamEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_REVIEW_TEAM] ?? false
	const fullTrustEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_FULL_TRUST] ?? false
	const questionEvaluationEnabled =
		experiments[EXPERIMENT_IDS.SELF_IMPROVING_QUESTION_EVALUATION] ?? false
	const promptQualityEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_PROMPT_QUALITY] ?? false
	const toolPreferenceEnabled =
		experiments[EXPERIMENT_IDS.SELF_IMPROVING_TOOL_PREFERENCE] ?? false
	const skillMergeEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_SKILL_MERGE] ?? false
	const persistCountsEnabled =
		experiments[EXPERIMENT_IDS.SELF_IMPROVING_PERSIST_COUNTS] ?? false
	const codeIndexEnabled = experiments[EXPERIMENT_IDS.SELF_IMPROVING_CODE_INDEX] ?? false
	const currentMemoryBackend = memoryBackend ?? "builtin"
	const currentSelfImprovingScope = selfImprovingScope ?? "global"
	const currentAutoSkillsScope = selfImprovingAutoSkillsScope ?? "workspace"

	return (
		<div className="space-y-3">
			<ExperimentalFeature
				experimentKey="SELF_IMPROVING"
				enabled={experiments[EXPERIMENT_IDS.SELF_IMPROVING] ?? false}
				onChange={(enabled) => setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING, enabled)}
				checkboxTestId="experimental-self-improving-checkbox"
			/>
			{autoSkillsVisible && (
				<div className="ml-6 space-y-3 border-l border-vscode-panel-border pl-4">
					{/* Scope selector */}
					{setSelfImprovingScope && (
						<div className="space-y-2">
							<label className="block font-medium">
								{t("settings:experimental.SELF_IMPROVING.scopeLabel", {
									defaultValue: "Self-learning scope",
								})}
							</label>
							<Select
								value={currentSelfImprovingScope}
								onValueChange={(value) =>
									setSelfImprovingScope(value as "workspace" | "global")
								}
								data-testid="self-improving-scope-select">
								<SelectTrigger className="w-full">
									<SelectValue placeholder={t("settings:common.select")} />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="workspace">
										{t("settings:experimental.SELF_IMPROVING.scopeWorkspace", {
											defaultValue: "Workspace",
										})}
									</SelectItem>
									<SelectItem value="global">
										{t("settings:experimental.SELF_IMPROVING.scopeGlobal", {
											defaultValue: "Global",
										})}
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					)}

					{/* Auto Skills */}
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_AUTO_SKILLS"
						enabled={autoSkillsEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_AUTO_SKILLS, enabled)
						}
						checkboxTestId="experimental-self-improving-auto-skills-checkbox"
					/>
					{autoSkillsEnabled && setSelfImprovingAutoSkillsScope && (
						<div className="space-y-2">
							<label className="block font-medium">
								{t("settings:experimental.SELF_IMPROVING.autoSkillsScopeLabel", {
									defaultValue: "Auto-create/update skills scope",
								})}
							</label>
							<Select
								value={currentAutoSkillsScope}
								onValueChange={(value) =>
									setSelfImprovingAutoSkillsScope(value as "workspace" | "global")
								}
								data-testid="self-improving-auto-skills-scope-select">
								<SelectTrigger className="w-full">
									<SelectValue placeholder={t("settings:common.select")} />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="workspace">
										{t("settings:experimental.SELF_IMPROVING.scopeWorkspace", {
											defaultValue: "Workspace",
										})}
									</SelectItem>
									<SelectItem value="global">
										{t("settings:experimental.SELF_IMPROVING.scopeGlobal", {
											defaultValue: "Global",
										})}
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					)}

					{/* Memory backend */}
					{setMemoryBackend && (
						<div className="space-y-2">
							<label className="block font-medium">
								{t("settings:experimental.SELF_IMPROVING.memoryBackendLabel", {
									defaultValue: "Memory backend",
								})}
							</label>
							<Select
								value={currentMemoryBackend}
								onValueChange={(value) =>
									setMemoryBackend(value as "builtin" | "agentmemory")
								}
								data-testid="self-improving-memory-backend-select">
								<SelectTrigger className="w-full">
									<SelectValue placeholder={t("settings:common.select")} />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="builtin">
										{t("settings:experimental.SELF_IMPROVING.memoryBackendBuiltin", {
											defaultValue: "Built-in",
										})}
									</SelectItem>
									<SelectItem value="agentmemory">agentmemory</SelectItem>
								</SelectContent>
							</Select>
						</div>
					)}
					{currentMemoryBackend === "agentmemory" && setAgentMemoryUrl && (
						<div className="space-y-2">
							<label className="block font-medium">
								{t("settings:experimental.SELF_IMPROVING.agentMemoryUrlLabel", {
									defaultValue: "agentmemory URL",
								})}
							</label>
							<Input
								value={agentMemoryUrl ?? "http://localhost:3111"}
								onChange={(event) => setAgentMemoryUrl(event.target.value)}
								placeholder="http://localhost:3111"
								data-testid="self-improving-agent-memory-url-input"
							/>
						</div>
					)}

					{/* Sub-features */}
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_AUTO_MODE"
						enabled={autoModeEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_AUTO_MODE, enabled)
						}
						checkboxTestId="experimental-self-improving-auto-mode-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_REVIEW_TEAM"
						enabled={reviewTeamEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_REVIEW_TEAM, enabled)
						}
						checkboxTestId="experimental-self-improving-review-team-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_FULL_TRUST"
						enabled={fullTrustEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_FULL_TRUST, enabled)
						}
						checkboxTestId="experimental-self-improving-full-trust-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_QUESTION_EVALUATION"
						enabled={questionEvaluationEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_QUESTION_EVALUATION, enabled)
						}
						checkboxTestId="experimental-self-improving-question-evaluation-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_PROMPT_QUALITY"
						enabled={promptQualityEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_PROMPT_QUALITY, enabled)
						}
						checkboxTestId="experimental-self-improving-prompt-quality-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_TOOL_PREFERENCE"
						enabled={toolPreferenceEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_TOOL_PREFERENCE, enabled)
						}
						checkboxTestId="experimental-self-improving-tool-preference-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_SKILL_MERGE"
						enabled={skillMergeEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_SKILL_MERGE, enabled)
						}
						checkboxTestId="experimental-self-improving-skill-merge-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_PERSIST_COUNTS"
						enabled={persistCountsEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_PERSIST_COUNTS, enabled)
						}
						checkboxTestId="experimental-self-improving-persist-counts-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="SELF_IMPROVING_CODE_INDEX"
						enabled={codeIndexEnabled}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING_CODE_INDEX, enabled)
						}
						checkboxTestId="experimental-self-improving-code-index-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="ONE_SHOT_ORCHESTRATOR"
						enabled={experiments[EXPERIMENT_IDS.ONE_SHOT_ORCHESTRATOR] ?? false}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.ONE_SHOT_ORCHESTRATOR, enabled)
						}
						checkboxTestId="experimental-one-shot-orchestrator-checkbox"
					/>
					<ExperimentalFeature
						experimentKey="KAIZEN_ORCHESTRATOR"
						enabled={experiments[EXPERIMENT_IDS.KAIZEN_ORCHESTRATOR] ?? false}
						onChange={(enabled) =>
							setExperimentEnabled(EXPERIMENT_IDS.KAIZEN_ORCHESTRATOR, enabled)
						}
						checkboxTestId="experimental-kaizen-orchestrator-checkbox"
					/>
					<SelfImprovingStatus />
				</div>
			)}
		</div>
	)
}

/** Renders the image generation experiment with its sub-settings. */
const ImageGenerationSection = ({
	experiments,
	setExperimentEnabled,
	imageGenerationProvider,
	openRouterImageApiKey,
	openRouterImageGenerationSelectedModel,
	setImageGenerationProvider,
	setOpenRouterImageApiKey,
	setImageGenerationSelectedModel,
}: {
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
	imageGenerationProvider?: ImageGenerationProvider
	openRouterImageApiKey?: string
	openRouterImageGenerationSelectedModel?: string
	setImageGenerationProvider?: (provider: ImageGenerationProvider) => void
	setOpenRouterImageApiKey?: (apiKey: string) => void
	setImageGenerationSelectedModel?: (model: string) => void
}) => {
	const { t } = useAppTranslation()
	const label = t("settings:experimental.IMAGE_GENERATION.name")

	return (
		<SearchableSetting
			settingId="experimental-image-generation"
			section="experimental"
			label={label}>
			<ImageGenerationSettings
				enabled={experiments[EXPERIMENT_IDS.IMAGE_GENERATION] ?? false}
				onChange={(enabled) => setExperimentEnabled(EXPERIMENT_IDS.IMAGE_GENERATION, enabled)}
				imageGenerationProvider={imageGenerationProvider}
				openRouterImageApiKey={openRouterImageApiKey}
				openRouterImageGenerationSelectedModel={openRouterImageGenerationSelectedModel}
				setImageGenerationProvider={setImageGenerationProvider!}
				setOpenRouterImageApiKey={setOpenRouterImageApiKey!}
				setImageGenerationSelectedModel={setImageGenerationSelectedModel!}
			/>
		</SearchableSetting>
	)
}

/** Renders the custom tools experiment with its sub-settings. */
const CustomToolsSection = ({
	experiments,
	setExperimentEnabled,
}: {
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
}) => {
	const { t } = useAppTranslation()
	const label = t("settings:experimental.CUSTOM_TOOLS.name")

	return (
		<SearchableSetting
			settingId="experimental-custom-tools"
			section="experimental"
			label={label}>
			<CustomToolsSettings
				enabled={experiments[EXPERIMENT_IDS.CUSTOM_TOOLS] ?? false}
				onChange={(enabled) => setExperimentEnabled(EXPERIMENT_IDS.CUSTOM_TOOLS, enabled)}
			/>
		</SearchableSetting>
	)
}

/** Renders a category group with a sub-header and its experiments. */
const CategoryGroup = ({
	category,
	experiments,
	setExperimentEnabled,
	renderInline,
}: {
	category: ExperimentCategory
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
	renderInline: (key: string) => React.ReactNode
}) => {
	const { t } = useAppTranslation()

	return (
		<div className="space-y-2">
			<h4 className="text-sm font-semibold text-vscode-foreground mt-4 mb-1">
				{t(category.labelKey)}
			</h4>
			<p className="text-xs text-vscode-descriptionForeground mb-2">
				{t(category.descriptionKey)}
			</p>
			{category.experimentKeys.map((key) => (
				<div key={key}>{renderInline(key)}</div>
			))}
		</div>
	)
}

// ── Main component ────────────────────────────────────────────────────

export const ExperimentalSettings = ({
	experiments,
	setExperimentEnabled,
	apiConfiguration,
	setApiConfigurationField,
	imageGenerationProvider,
	openRouterImageApiKey,
	openRouterImageGenerationSelectedModel,
	memoryBackend,
	agentMemoryUrl,
	selfImprovingScope,
	selfImprovingAutoSkillsScope,
	setImageGenerationProvider,
	setOpenRouterImageApiKey,
	setImageGenerationSelectedModel,
	setMemoryBackend,
	setAgentMemoryUrl,
	setSelfImprovingScope,
	setSelfImprovingAutoSkillsScope,
	setLenientModes,
	verificationLevel,
	setVerificationLevel,
	className,
	...props
}: ExperimentalSettingsProps) => {
	const { t } = useAppTranslation()

	// ── Render helpers ──────────────────────────────────────────────

	/** Renders an experiment by key, dispatching to inline sections or simple toggles. */
	const renderExperiment = (key: string): React.ReactNode => {
		if (key === "SELF_IMPROVING") {
			return (
				<SelfImprovingSection
					experiments={experiments}
					setExperimentEnabled={setExperimentEnabled}
					selfImprovingScope={selfImprovingScope}
					setSelfImprovingScope={setSelfImprovingScope}
					selfImprovingAutoSkillsScope={selfImprovingAutoSkillsScope}
					setSelfImprovingAutoSkillsScope={setSelfImprovingAutoSkillsScope}
					memoryBackend={memoryBackend}
					setMemoryBackend={setMemoryBackend}
					agentMemoryUrl={agentMemoryUrl}
					setAgentMemoryUrl={setAgentMemoryUrl}
				/>
			)
		}
		if (key === "IMAGE_GENERATION") {
			return (
				<ImageGenerationSection
					experiments={experiments}
					setExperimentEnabled={setExperimentEnabled}
					imageGenerationProvider={imageGenerationProvider}
					openRouterImageApiKey={openRouterImageApiKey}
					openRouterImageGenerationSelectedModel={openRouterImageGenerationSelectedModel}
					setImageGenerationProvider={setImageGenerationProvider}
					setOpenRouterImageApiKey={setOpenRouterImageApiKey}
					setImageGenerationSelectedModel={setImageGenerationSelectedModel}
				/>
			)
		}
		if (key === "CUSTOM_TOOLS") {
			return (
				<CustomToolsSection
					experiments={experiments}
					setExperimentEnabled={setExperimentEnabled}
				/>
			)
		}
		return (
			<SimpleExperimentToggle
				experimentKey={key}
				experiments={experiments}
				setExperimentEnabled={setExperimentEnabled}
			/>
		)
	}

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader description={t("settings:sections.experimentalDescription")}>
				{t("settings:sections.experimental")}
			</SectionHeader>

			<Section>
				{CATEGORIES.map((category) => (
					<CategoryGroup
						key={category.key}
						category={category}
						experiments={experiments}
						setExperimentEnabled={setExperimentEnabled}
						renderInline={renderExperiment}
					/>
				))}

				{/* Standalone experiments not in any category */}
				{Object.entries(experimentConfigsMap)
					.filter(([key]) => !INLINE_KEYS.has(key))
					.map(([key]) => (
						<div key={key}>{renderExperiment(key)}</div>
					))}

				{/* Lenient Modes */}
				<SearchableSetting
					settingId="experimental-lenient-modes"
					section="experimental"
					label="Lenient Modes"
					description="Modes that skip code quality verification on completion (comma-separated mode slugs)">
					<Input
						value={(experiments.lenientModes as string[] | undefined)?.join(", ") ?? "research"}
						onChange={(e) => {
							const modes = e.target.value
								.split(",")
								.map((m) => m.trim())
								.filter(Boolean)
							setLenientModes?.(modes)
						}}
						placeholder="research, ask, architect"
						data-testid="experimental-lenient-modes-input"
					/>
				</SearchableSetting>

				{/* Verification Level */}
				<SearchableSetting
					settingId="experimental-verification-level"
					section="experimental"
					label="Verification Level"
					description="Controls how requirements verification behaves on attempt_completion">
					<Select
						value={verificationLevel ?? "strict"}
						onValueChange={(value: "strict" | "lenient" | "bypass") =>
							setVerificationLevel?.(value)
						}>
						<SelectTrigger data-testid="experimental-verification-level-select">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="strict">Strict — All requirements must be verified</SelectItem>
							<SelectItem value="lenient">Lenient — Log warnings, don't block</SelectItem>
							<SelectItem value="bypass">Bypass — Skip requirements verification</SelectItem>
						</SelectContent>
					</Select>
				</SearchableSetting>
			</Section>
		</div>
	)
}
