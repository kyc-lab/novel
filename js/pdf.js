// 회차 PDF 만들기 (브라우저 안에서, 외부 도구 없이).
//
// 방식: 종이(A4) 크기의 그림판에 글을 직접 그려서 쪽마다 그림으로 넣는다.
//   → 앱에 넣어 둔 한글 글꼴로 그리기 때문에 어느 기기에서 열어도 글자가 안 깨지고 모양이 같다.
// 그리고 그 그림 위에 "보이지 않는 글자"를 같은 자리에 겹쳐 넣는다.
//   → PDF에서 글을 드래그해 복사하거나 검색할 수 있다.

const PAGE_W_PT = 595.28; // A4 (포인트)
const PAGE_H_PT = 841.89;
const DPI = 180;
const W = Math.round((PAGE_W_PT / 72) * DPI); // 그림판 가로(픽셀)
const H = Math.round((PAGE_H_PT / 72) * DPI);
const PX = DPI / 72; // 1포인트 = 몇 픽셀

const MARGIN_X = 62 * PX;
const MARGIN_TOP = 70 * PX;
const MARGIN_BOTTOM = 70 * PX;
const BODY_SIZE = 10.5 * PX;
const LINE_H = BODY_SIZE * 1.85;
const TITLE_SIZE = 16 * PX;
const SMALL_SIZE = 8.5 * PX;

// 줄 맨 앞에 오면 안 되는 글자 / 줄 맨 끝에 오면 안 되는 글자
const NO_START = new Set([...'.,!?…⋯。、”’」』》〉)]}~·―-:;%']);
const NO_END = new Set([...'“‘「『《〈([{']);

// 글을 "떼면 안 되는 덩어리"로 나눈다: 한글·한자는 한 글자씩, 영문·숫자는 단어째로.
function toUnits(text) {
  const units = [];
  let word = '';
  for (const ch of text) {
    if (/[A-Za-z0-9]/.test(ch)) {
      word += ch;
      continue;
    }
    if (word) {
      units.push(word);
      word = '';
    }
    units.push(ch);
  }
  if (word) units.push(word);
  // 금칙: 닫는 부호는 앞 덩어리에, 여는 부호는 뒤 덩어리에 붙인다.
  const merged = [];
  for (const u of units) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && (NO_START.has(u) || NO_END.has([...prev].at(-1)))) merged[merged.length - 1] = prev + u;
    else merged.push(u);
  }
  return merged;
}

// 한 문단을 너비에 맞게 여러 줄로 나눈다.
function wrap(ctx, para, maxWidth) {
  if (!para) return [''];
  const lines = [];
  let line = '';
  for (const unit of toUnits(para)) {
    if (line && ctx.measureText(line + unit).width > maxWidth) {
      lines.push(line.trimEnd());
      line = unit.trimStart();
    } else {
      line += unit;
    }
    // 덩어리 하나가 한 줄보다 길면(긴 영문 등) 글자 단위로 자른다.
    while (ctx.measureText(line).width > maxWidth && [...line].length > 1) {
      const chars = [...line];
      let cut = chars.length - 1;
      while (cut > 1 && ctx.measureText(chars.slice(0, cut).join('')).width > maxWidth) cut--;
      lines.push(chars.slice(0, cut).join(''));
      line = chars.slice(cut).join('');
    }
  }
  lines.push(line);
  return lines;
}

// ───────── PDF 파일 조립 ─────────

const enc = new TextEncoder();
const hexUtf16 = (s) => {
  let out = '';
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, '0');
  return out.toUpperCase();
};
const num = (n) => Number(n.toFixed(2));

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 보이지 않는 글자를 "코드 = 유니코드"로 읽게 해 주는 표(복사·검색용)
function toUnicodeCMap() {
  const ranges = [];
  for (let hi = 0; hi < 256; hi++) {
    const h = hi.toString(16).padStart(2, '0').toUpperCase();
    ranges.push(`<${h}00> <${h}FF> <${h}00>`);
  }
  let body = '';
  for (let i = 0; i < ranges.length; i += 100) {
    const part = ranges.slice(i, i + 100);
    body += `${part.length} beginbfrange\n${part.join('\n')}\nendbfrange\n`;
  }
  return (
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    body +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'
  );
}

class PdfWriter {
  constructor() {
    this.parts = [];
    this.size = 0;
    this.offsets = []; // 객체 번호 → 파일 안 위치
    this.count = 0;
    this.push('%PDF-1.5\n%âãÏÓ\n');
  }
  push(data) {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    this.parts.push(bytes);
    this.size += bytes.length;
  }
  reserve() {
    return ++this.count;
  }
  // 일반 객체
  write(id, dict) {
    this.offsets[id] = this.size;
    this.push(`${id} 0 obj\n${dict}\nendobj\n`);
  }
  // 내용물(압축한 바이트)이 딸린 객체. props는 << >> 안에 들어갈 항목들.
  writeStream(id, props, bytes) {
    this.offsets[id] = this.size;
    this.push(`${id} 0 obj\n<< ${props} /Filter /FlateDecode /Length ${bytes.length} >>\nstream\n`);
    this.push(bytes);
    this.push('\nendstream\nendobj\n');
  }
  finish(rootId) {
    const xref = this.size;
    let table = `xref\n0 ${this.count + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= this.count; i++) table += `${String(this.offsets[i]).padStart(10, '0')} 00000 n \n`;
    this.push(table + `trailer\n<< /Size ${this.count + 1} /Root ${rootId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(this.parts, { type: 'application/pdf' });
  }
}

// ───────── 회차 → PDF ─────────

// { workTitle, no(몇 화), title, body, fontFamily } → PDF Blob
export async function makeChapterPdf({ workTitle, no, title, body, fontFamily }) {
  const family = `"${fontFamily}", serif`;
  const fontOf = (size, weight = 400) => `${weight} ${size}px ${family}`;
  // 글꼴이 다 내려받아질 때까지 기다린다(안 기다리면 다른 글꼴로 그려진다).
  await Promise.all([document.fonts.load(fontOf(BODY_SIZE)), document.fonts.load(fontOf(TITLE_SIZE, 700))]).catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.textBaseline = 'alphabetic';
  const maxWidth = W - MARGIN_X * 2;

  // 1) 쪽 나누기: 쪽마다 그릴 줄 목록 [{ text, x, y, size, weight, color }]
  const heading = `${no}화${title ? ' ' + title : ''}`;
  const pages = [];
  let lines = [];
  let y = MARGIN_TOP;
  const newPage = () => {
    pages.push(lines);
    lines = [];
    y = MARGIN_TOP;
  };

  ctx.font = fontOf(TITLE_SIZE, 700);
  for (const text of wrap(ctx, heading, maxWidth)) {
    y += TITLE_SIZE;
    lines.push({ text, x: MARGIN_X, y, size: TITLE_SIZE, weight: 700, color: '#000' });
    y += TITLE_SIZE * 0.5;
  }
  y += LINE_H * 1.2;

  ctx.font = fontOf(BODY_SIZE);
  for (const para of body.replace(/\r/g, '').split('\n')) {
    for (const text of wrap(ctx, para, maxWidth)) {
      if (y + LINE_H > H - MARGIN_BOTTOM) newPage();
      y += LINE_H;
      if (text) lines.push({ text, x: MARGIN_X, y, size: BODY_SIZE, weight: 400, color: '#111' });
    }
  }
  pages.push(lines);

  // 2) PDF 뼈대
  const pdf = new PdfWriter();
  const catalogId = pdf.reserve();
  const pagesId = pdf.reserve();
  const fontId = pdf.reserve();
  const cidFontId = pdf.reserve();
  const descId = pdf.reserve();
  const cmapId = pdf.reserve();
  const pageIds = [];

  pdf.write(
    fontId,
    `<< /Type /Font /Subtype /Type0 /BaseFont /JipilText /Encoding /Identity-H /DescendantFonts [${cidFontId} 0 R] /ToUnicode ${cmapId} 0 R >>`,
  );
  pdf.write(
    cidFontId,
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /JipilText /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descId} 0 R /DW 1000 >>`,
  );
  pdf.write(
    descId,
    '<< /Type /FontDescriptor /FontName /JipilText /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
  );
  pdf.writeStream(cmapId, '', await deflate(enc.encode(toUnicodeCMap())));

  // 3) 쪽마다: 그림 그리기 → 그림 + 보이지 않는 글자
  const scale = PAGE_W_PT / W; // 픽셀 → 포인트
  for (let p = 0; p < pages.length; p++) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    const footer = [];
    if (workTitle) footer.push({ text: workTitle, x: MARGIN_X, y: 40 * PX, size: SMALL_SIZE, weight: 400, color: '#777' });
    const pageNo = `${p + 1} / ${pages.length}`;
    ctx.font = fontOf(SMALL_SIZE);
    footer.push({ text: pageNo, x: (W - ctx.measureText(pageNo).width) / 2, y: H - 36 * PX, size: SMALL_SIZE, weight: 400, color: '#777' });

    let textOps = '';
    for (const ln of [...footer, ...pages[p]]) {
      ctx.font = fontOf(ln.size, ln.weight);
      ctx.fillStyle = ln.color;
      ctx.fillText(ln.text, ln.x, ln.y);
      // 보이지 않는 글자: 글자 수 × 글자 크기 너비를, 실제로 그려진 너비에 맞게 가로로 늘이거나 줄인다.
      const sizePt = ln.size * scale;
      const widthPt = ctx.measureText(ln.text).width * scale;
      const tz = (widthPt / (ln.text.length * sizePt)) * 100;
      textOps += `BT /F1 ${num(sizePt)} Tf 3 Tr ${num(tz)} Tz ${num(ln.x * scale)} ${num(PAGE_H_PT - ln.y * scale)} Td <${hexUtf16(ln.text)}> Tj ET\n`;
    }

    // 흑백 그림으로 바꿔서(용량 절약) 압축
    const rgba = ctx.getImageData(0, 0, W, H).data;
    const gray = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;

    const imageId = pdf.reserve();
    const contentId = pdf.reserve();
    const pageId = pdf.reserve();
    pageIds.push(pageId);
    pdf.writeStream(
      imageId,
      `/Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8`,
      await deflate(gray),
    );
    const content = `q ${PAGE_W_PT} 0 0 ${PAGE_H_PT} 0 0 cm /Im0 Do Q\n${textOps}`;
    pdf.writeStream(contentId, '', await deflate(enc.encode(content)));
    pdf.write(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W_PT} ${PAGE_H_PT}] /Resources << /XObject << /Im0 ${imageId} 0 R >> /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
  }

  pdf.write(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  pdf.write(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return { blob: pdf.finish(catalogId), pages: pages.length };
}
