export function sessionNewResolution(created: boolean, cancelled: boolean): "created" | "cancelled" | "failed" {
  return created ? "created" : cancelled ? "cancelled" : "failed";
}

/** Tracks cancellable session.new requests while the utility command queue is busy. */
export class SessionNewClaims {
  private readonly pending = new Map<string, { cancelled: boolean }>();

  register(id: string): { cancelled: boolean } {
    const claim = { cancelled: false };
    this.pending.set(id, claim);
    return claim;
  }

  cancel(id: string): void {
    const claim = this.pending.get(id);
    if (claim) claim.cancelled = true;
  }

  get(id: string): { cancelled: boolean } | undefined {
    return this.pending.get(id);
  }

  finish(id: string, claim: { cancelled: boolean }): void {
    if (this.pending.get(id) === claim) this.pending.delete(id);
  }
}
