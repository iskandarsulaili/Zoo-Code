import { useMemo, useCallback } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import type { ModeConfig, VerificationLevel } from "@roo-code/types"

import { getAllModes } from "@roo/modes"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui"
import { SearchableSetting } from "./SearchableSetting"
import { Section } from "./Section"

type VerificationSettingsProps = {
	customModes: ModeConfig[]
	lenientModes: string[]
	verificationLevel: VerificationLevel | undefined
	verificationLevels: Record<string, VerificationLevel> | undefined
	setLenientModes: (modes: string[]) => void
	setVerificationLevel: (level: VerificationLevel) => void
	setVerificationLevels: (levels: Record<string, VerificationLevel>) => void
}

const VERIFICATION_LEVEL_OPTIONS: { value: VerificationLevel; label: string }[] = [
	{ value: "strict", label: "Strict — All requirements must be verified" },
	{ value: "lenient", label: "Lenient — Log warnings, don't block" },
	{ value: "bypass", label: "Bypass — Skip requirements verification" },
]

export const VerificationSettings = ({
	customModes,
	lenientModes,
	verificationLevel,
	verificationLevels,
	setLenientModes,
	setVerificationLevel,
	setVerificationLevels,
}: VerificationSettingsProps) => {
	const allModes = useMemo(() => getAllModes(customModes), [customModes])

	const lenientSet = useMemo(() => new Set(lenientModes ?? []), [lenientModes])
	const levels = useMemo(() => verificationLevels ?? {}, [verificationLevels])

	const handleModeToggle = useCallback(
		(slug: string, checked: boolean) => {
			const updated = checked
				? [...(lenientModes ?? []), slug]
				: (lenientModes ?? []).filter((m) => m !== slug)
			setLenientModes(updated)
		},
		[lenientModes, setLenientModes],
	)

	const handleLevelChange = useCallback(
		(slug: string, level: VerificationLevel) => {
			setVerificationLevels({ ...levels, [slug]: level })
		},
		[levels, setVerificationLevels],
	)

	return (
		<Section>
			{/* Default Verification Level */}
			<SearchableSetting
				settingId="experimental-verification-level"
				section="experimental"
				label="Default Verification Level"
				description="Controls how requirements verification behaves on attempt_completion by default">
				<Select
					value={verificationLevel ?? "strict"}
					onValueChange={(value: VerificationLevel) => setVerificationLevel(value)}>
					<SelectTrigger data-testid="experimental-verification-level-select">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{VERIFICATION_LEVEL_OPTIONS.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SearchableSetting>

			{/* Per-Mode Verification Settings */}
			<div className="flex flex-col gap-1">
				<span className="text-vscode-foreground text-sm font-medium">Per-Mode Verification</span>
				<span className="text-vscode-descriptionForeground text-xs mb-2">
					Override verification behavior for specific modes. Checked modes use lenient/bypass instead of the
					default level.
				</span>
				{allModes.map((mode) => {
					const isLenient = lenientSet.has(mode.slug)
					const modeLevel = levels[mode.slug] ?? verificationLevel ?? "strict"

					return (
						<div
							key={mode.slug}
							className="flex items-center gap-3 py-1.5 px-2 rounded hover:bg-vscode-list-hoverBackground">
							<VSCodeCheckbox
								checked={isLenient}
								onChange={(e: any) => handleModeToggle(mode.slug, e.target.checked)}>
								{mode.name ?? mode.slug}
							</VSCodeCheckbox>
							{isLenient && (
								<Select
									value={modeLevel}
									onValueChange={(value: VerificationLevel) => handleLevelChange(mode.slug, value)}>
									<SelectTrigger className="w-48" data-testid={`verification-level-${mode.slug}`}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{VERIFICATION_LEVEL_OPTIONS.map((opt) => (
											<SelectItem key={opt.value} value={opt.value}>
												{opt.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</div>
					)
				})}
			</div>
		</Section>
	)
}
