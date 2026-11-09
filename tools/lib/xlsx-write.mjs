// 검사·대조용 .xlsx 쓰기(Node): core/xlsx-write.ts에 Node 압축(zlib)을 붙인다.
import { deflateRawSync } from 'node:zlib';
import { writeXlsx as coreWrite } from '../../core/xlsx-write.ts';

/** sheets: { 시트 이름: [[...], ...] } → .xlsx 바이트. compress = false면 저장 방식 */
export function writeXlsx(sheets, { compress = true, links } = {}) {
  return coreWrite(sheets, { ...(compress ? { deflate: d => new Uint8Array(deflateRawSync(d)) } : {}), ...(links ? { links } : {}) });
}
