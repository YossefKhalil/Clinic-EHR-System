# Plan: AI import — a calmer, professional UI (same power, optional detail)

Status: proposal. Companion docs:
[`local-ai-runtime-issue.md`](local-ai-runtime-issue.md),
[`mlc-runtime-plan.md`](mlc-runtime-plan.md).

## Problem

The AI import works, but the interface asks the clinic to be an operator:

- The **settings card** mixes decisions (which engine, which model) with knobs
  (KV cache type, micro-batch, lease seconds) at the same level. Everything is
  always visible, so nothing stands out and mistakes are easy.
- Errors are codes and badges ("Error (GGUF_TEMPLATE_MISSING)") instead of a
  sentence with a next step.
- The **wizard** hides progress behind one spinner line; a 30-minute local
  extraction looks frozen.
- Nothing tells the clinic *whether the machine can do this* before they commit.

## Principles

1. **One obvious path, everything else progressive.** The common case is three
   decisions; every knob stays reachable in a collapsed "Advanced" area.
2. **Plain sentences for outcomes, codes for diagnostics.** A refusal says what
   happened, why, and the next click. Codes live behind "Details".
3. **Show capacity before commitment.** Device readiness is a health card, not a
   row of chips to decode.
4. **Nothing hidden is lost.** Every existing control has a place; parity is a
   checklist, not a vibe.

## Settings → AI (target shape)

```
┌──────────────────────────────────────────────────────────────┐
│  Engine                                                       │
│  ┌───────────┐  ┌────────────────┐  ┌─────────────────────┐  │
│  │ Off       │  │ Cloud          │  │ This computer   ✓   │  │
│  └───────────┘  └────────────────┘  └─────────────────────┘  │
│                                                                │
│  Model                              Status: ● Ready            │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ gemma-4-E2B-it (downloaded, 3.2 GB)                      │ │
│  │ Reads photos · context 131k · runs on this PC's GPU      │ │
│  │ [Change model]  [Remove]                                 │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ▸ Advanced (12 settings)                                     │
└──────────────────────────────────────────────────────────────┘
```

- **Engine cards** replace the segmented control: each card carries one line of
  consequence ("sends patient data to the provider" / "stays on this PC").
- **Model card**: one model, one status dot, one human sentence
  ("Ready · reads photos · runs on the GPU"). `Change model` opens the picker.
- **Two ways to get a model**, side by side:
  - *Recommended (download)* — the MLC catalog filtered by this device
    (see `mlc-runtime-plan.md`); shows download size before committing.
  - *Use my own files* — the existing Browse → Verify flow, unchanged.
- **Advanced drawer** (collapsed, count in the label) holds today's groups
  verbatim: layout (single/split), projector, text knobs, OCR knobs, runtime
  knobs, chat-template override. A **Reset to recommended** button per group.
- **Readiness health card**: one dot + one sentence
  ("Ready — 8 GB RAM, GPU detected, 40 GB free") with the current chips inside a
  `Details` disclosure, plus the System RAM field when the browser reports none.
- **Errors**: sentence → next action → `Show technical details` (code + message,
  copy button). No bare codes as primary text.

## Import wizard (target shape)

- **Add**: full-height drop zone, file chips with per-file status, optional
  hints/section collapsed under "More options".
- **Extract**: one progress ring (chunks done / total) + a live line of
  per-chunk events (claimed → reading photos → extracting → done/failed with the
  reason) + an honest note ("this can take a while; you can keep this tab in the
  background"). Failures render the reason inline, not only in the review.
- **Review**: unchanged functionally; add a sticky action bar
  (import / ready count / section default) and the keyboard hint surfaced.
- **Resume**: an "Open AI settings" button becomes "Fix the model" and jumps to
  the exact failing card.

## Parity checklist (nothing disappears)

| Today | Tomorrow |
|---|---|
| Engine segmented control + consent modal | Engine cards; consent stays on the Cloud card |
| Layout select (single/split) | Advanced ▸ Layout |
| Multimodal / mmproj / text / vision cards with browse-verify-remove | Advanced ▸ "Use my own files" (same cards, same states) |
| Recommended-model download card (MLC plan) | Model card ▸ Change model ▸ Recommended |
| Text/OCR/runtime field groups (context, KV cache, GPU layers, threads, batch, sampling, thinking, repair, chat template, strips, lease…) | Advanced ▸ same groups, same bounds, same validation, plus Reset-to-recommended |
| Device chips (WebGPU, threads, RAM, storage, tier) + System RAM field | Health card ▸ Details |
| Readiness errors (arch, template, hash, kind, support files) | Same codes, sentence-first presentation |
| Cloud chain editor, credentials, quotas | Unchanged (different tab; out of scope here) |
| Review table (Simple/Advanced), dupes, trays, commit | Unchanged; sticky action bar added |

## Interaction details

- Every long action gets progress or a skeleton; nothing spins blind.
- `aria-live="polite"` on progress and failures; RTL mirrored icons; Arabic copy
  reviewed alongside English (the app is Arabic-first for this clinic).
- Destructive actions (Remove model, Discard changes) keep their confirm.
- The Advanced drawer state persists per account, like the view presets do.

## Rollout

| Phase | Scope | Guardrail |
|---|---|---|
| 0 | audit every control into the parity table (above) | sign-off that nothing is dropped |
| 1 | engine cards + health card (read-only refactor of existing state) | no settings-schema change |
| 2 | model card + picker (own files first; catalog when MLC lands) | existing verify flow untouched |
| 3 | Advanced drawer with today's groups | all field bounds/validation reused |
| 4 | wizard extract/review polish + inline failure reasons | no API change |
| 5 | copy review (EN/AR), a11y pass, screenshots for the docs | both locales complete |

## Success criteria

- A new admin can enable the local engine and run a text import without docs.
- Every setting that exists today is reachable within two clicks.
- Every failure state shows a sentence, a next action, and (behind Details) the
  technical message.
- Time-to-first-extracted-record on a clean machine drops (measured against the
  golden fixture run).
