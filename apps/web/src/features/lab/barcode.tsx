/**
 * Code 128 (set B) barcodes as SVG, for accession numbers on sample labels. Any USB barcode
 * scanner reads them back as typed text, so the lab can scan a tube to find its order.
 */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const STOP = 106;

/** The module widths (bar, space, bar, …) for `text`, including start, checksum and stop. */
export function code128(text: string): number[] {
  const values = [...text].map((c) => {
    const v = c.charCodeAt(0) - 32;
    if (v < 0 || v > 94) throw new Error(`Code 128B can't encode ${JSON.stringify(c)}`);
    return v;
  });
  const check = values.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103;
  return [START_B, ...values, check, STOP].flatMap((v) => [...PATTERNS[v]!].map(Number));
}

export function Barcode({ value, height = 28, module = 1.3 }: { value: string; height?: number; module?: number }) {
  const widths = code128(value);
  const quiet = 10;
  const total = widths.reduce((a, b) => a + b, 0) + quiet * 2;
  let x = quiet;
  const bars = widths.map((w, i) => {
    const bar = i % 2 === 0 ? <rect key={i} x={x} y={0} width={w} height={height} /> : null;
    x += w;
    return bar;
  });
  return (
    <svg role="img" aria-label={`Barcode ${value}`} viewBox={`0 0 ${total} ${height}`} width={total * module} height={height} preserveAspectRatio="none" fill="#000">
      {bars}
    </svg>
  );
}
