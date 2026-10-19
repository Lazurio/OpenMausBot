
import { transitionComputerControlLease } from "../lib/computer-control";

const snap = (held: boolean) => ({ held, helpReason: null });

    const calls: string[] = [];
    await transitionComputerControlLease({
      action: "take",
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(true); },
    });
    await transitionComputerControlLease({
      action: "release",
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(false); },
    });
  });

    await expect(transitionComputerControlLease({
      action: "release",
      requestControl: async () => snap(true),
    })).rejects.toThrow(/could not release/i);
  });

    await expect(transitionComputerControlLease({
      action: "take",
  });
});
