#!/usr/bin/env node
// [CTO] T-034 · CLI entry for site-secret-scan-lib.mjs. Always runs main() (same reason as the other gates: an
// "am I main?" check silently skipped gates from symlinked or spaced paths; S-028 R-3).
// Skills used: security-and-hardening, karpathy-guidelines
import { main } from "./site-secret-scan-lib.mjs";

main();
