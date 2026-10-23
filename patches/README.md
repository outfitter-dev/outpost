# Upstream patches

Empty on purpose: we run Relay stock.

Each upstream has a folder (`patches/<name>/`). `scripts/upstream.mjs checkout`
applies every `*.patch` in it, in name order, on top of the pinned commit, so
CI, deploys and local checkouts all see the same patched tree. A patch that no
longer applies fails the bump PR instead of shipping silently.

Rules:

- Make patches with `git format-patch` from a checkout made by
  `node scripts/upstream.mjs checkout <name> --no-patches`. Name them
  `NNNN-short-name.patch`.
- Open an upstream PR for every patch and link it in the patch's commit
  message. Delete the patch once a release includes it.
- Adding new files, such as a new broker harness adapter, is cheap to carry.
  Edits to hot upstream files are not. If patches pile up or keep conflicting,
  move that one upstream to a fork (`outfitter-dev/<repo>`): point its `repo`
  in `upstream.json` at the fork and keep the other pins stock.
