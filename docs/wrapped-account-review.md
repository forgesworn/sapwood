# Wrapped-account preview review

Screens: Advanced > Identity > Back up or restore an existing raw account;
Heartwood's root, target and action approval pages. Source is the paired
`feat/wrapped-nsec-device` branches in Sapwood and heartwood-esp32. Build with
`npm run build`, serve with `npm run preview`, and use disposable test keys.

The browser suite `e2e/wrapped-account.spec.ts` uses the existing simulated-device
seam to check slot choices, a rejected oversized file, restore gating and a
390-pixel layout. It does not exercise a physical signer or its buttons.
Unit tests additionally exercise capability/authentication/frame exchange,
exact identity receipts, refusal paths and absence of automatic retry.
The source review also covers out-of-order file reads: selecting a new file,
including a rejected file, must invalidate every previous pending read.
Receipts must contain exactly the documented fields for their operation.

For the real-device review, use firmware built from the matching revision with
`wrapped_nsec_usb_v1`. Select A and raw B, download the record, select that saved
file and check B's exact npub. Expect complete npubs on the signer before each
physical approval, and no verified-backup claim after download alone. Cancel
once and try a wrong root/corrupt file; expect no mutation. After independently
backing up B, remove only its disposable slot, check the record, name B and
restore to the displayed empty slot. Reboot, compare B's exact npub and sign a
test event. Check its apps and delegate approvals are empty. Review the firmware
spec's interrupted-write matrix on a bench partition.
If final count publication has an uncertain acknowledgement, expect an
uncertain-outcome NACK and signer reboot. Reconnect and refresh identities
before another action; do not infer failure or retry automatically.

Automated checks, rendered device screens and a successful firmware build are
separate from physical recovery acceptance. Independent security review and
the physical ceremony remain pending until their exact evidence is recorded.
The paired firmware `WRAPPED-NSEC-REVIEW.md` records reproduced findings,
corrections, review limits and the bench acceptance table.
