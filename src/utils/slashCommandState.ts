// Tracks skills that have been loaded by user slash commands (/skill-name)
// in the current conversation turn. Used by SkillTool to avoid re-invoking
// skills that are already active in context (especially those with
// disableModelInvocation: true).
const slashLoadedSkills = new Set<string>()

export function markSlashLoaded(name: string): void {
  slashLoadedSkills.add(name)
}

export function isSlashLoaded(name: string): boolean {
  return slashLoadedSkills.has(name)
}

export function clearSlashLoaded(): void {
  slashLoadedSkills.clear()
}
