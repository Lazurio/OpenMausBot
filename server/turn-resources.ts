export type TurnOwner = {
  threadId: string;
  generation: string;
};

/** Whole-turn claims on app-managed resources (a phone), so every call of one turn sees the same device. Not a shell sandbox. */
export class TurnResources {
  private readonly owners = new Map<string, TurnOwner>();

  claim(resource: string, owner: TurnOwner): boolean {
    const current = this.owners.get(resource);
    if (current && !sameOwner(current, owner)) return false;
    this.owners.set(resource, owner);
    return true;
  }

  release(owner: TurnOwner): void {
    for (const [key, current] of this.owners) {
      if (sameOwner(current, owner)) this.owners.delete(key);
    }
  }
}

function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.threadId === b.threadId && a.generation === b.generation;
}
