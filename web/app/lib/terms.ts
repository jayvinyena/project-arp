// 용어 · 판정 사전(docs/34 T1): 화면마다 같은 말을 쓰게 한 곳에 모은다.
// 판정 알약은 색만으로 구분하지 않게 기호(icon)를 함께 쓴다(docs/34 D4).
import type { UpdateStatus } from '../../../engine/types.ts';

export interface Verdict { text: string; tone: 'ok' | 'warn' | 'bad' | ''; icon: string }

/** 업데이트 판정: 제작 완료 목표 · 출시일 기준 */
export const UPDATE_STATUS: Record<UpdateStatus, Verdict> = {
  ON_TRACK: { text: '목표 안', tone: 'ok', icon: '✓' },
  TIGHT: { text: '빠듯', tone: 'warn', icon: '!' },
  LATE: { text: '늦음', tone: 'bad', icon: '▲' },
  UNFINISHED: { text: '못 끝냄', tone: 'bad', icon: '✕' },
  NO_RELEASE_DATE: { text: '출시일 없음', tone: '', icon: '–' },
};

/** 배치 판정: 배치 마감일 기준(docs/33) */
export const BATCH_STATUS: Record<'ON_TRACK' | 'TIGHT' | 'LATE' | 'UNFINISHED' | 'NO_DUE', Verdict> = {
  ON_TRACK: { text: '마감 안', tone: 'ok', icon: '✓' },
  TIGHT: { text: '빠듯', tone: 'warn', icon: '!' },
  LATE: { text: '늦음', tone: 'bad', icon: '▲' },
  UNFINISHED: { text: '못 끝냄', tone: 'bad', icon: '✕' },
  NO_DUE: { text: '마감 없음', tone: '', icon: '–' },
};

/** 판정 글자(알림 · 소식처럼 글만 쓰는 곳) */
export const updateStatusText = (s: string) => UPDATE_STATUS[s as UpdateStatus]?.text ?? s;
