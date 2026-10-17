// Only one voice chat at a time: a room or a private call, on any network. Two at once
// would share one microphone and echo into each other.

export class VoiceSlot {
  private owner: object | null = null

  /** Takes the slot for `who`. False when someone else holds it. */
  claim(who: object): boolean {
    if (this.owner && this.owner !== who) return false
    this.owner = who
    return true
  }

  release(who: object): void {
    if (this.owner === who) this.owner = null
  }

  get busy(): boolean {
    return this.owner !== null
  }
}

/** The slot every real room and call uses. Tests make their own. */
export const voiceSlot = new VoiceSlot()
