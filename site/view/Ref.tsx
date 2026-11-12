// [CTO] T-033 · a tx hash or account id, rendered honestly: a placeholder is tagged and struck and
// gets no link; a real testnet value links to the explorer, shortened in the middle, full value in
// title + screen-reader text (build spec 5, "Tx links"). Lab: idHTML().
import type { LabFixture } from "../stage/schema.ts";
import { accountUrl, isPlaceholder, placeholderLabel, shortHash, txUrl } from "../stage/format.ts";

export const isTestnetRun = (f: LabFixture): boolean => f.network === "testnet" && f.mode !== "contract-test";

export function Ref({ value, kind, fixture, tag = "PLACEHOLDER" }: {
  value: string | null | undefined; kind: "tx" | "account" | "text"; fixture?: LabFixture; tag?: string;
}) {
  if (value == null || value === "") return <span>—</span>;
  if (isPlaceholder(value)) {
    return (
      <span className="phv" data-placeholder="">
        <span className="ph">{tag}</span>
        <s title={value}>{placeholderLabel(value)}</s>
      </span>
    );
  }
  const short = kind === "tx" ? shortHash(value) : value;
  if (kind !== "text" && fixture && isTestnetRun(fixture)) {
    const href = kind === "tx" ? txUrl(value) : accountUrl(value);
    return (
      <a className="lnk" href={href} target="_blank" rel="noopener noreferrer" title={value} data-tx={kind === "tx" ? value : undefined}>
        {kind === "tx" ? <><span aria-hidden="true">{short}</span><span className="sr">{value}</span></> : short}
      </a>
    );
  }
  return <span title={value}>{short}</span>;
}
