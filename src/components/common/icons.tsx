import type { SVGProps } from 'react';

// 品牌標誌：眼睛（檢視）+ 表格（明細帳）意象。與 favicon 一致：
// 橘色圓角底、白色眼形（取自 viewer.svg）、橘色方塊作為瞳孔。
export function Logo({ size = 22, ...props }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="LedgerView" {...props}>
      {/* 橘色圓角底 */}
      <rect width="64" height="64" rx="14" fill="#fd5108" />
      {/* 白色眼形 */}
      <path
        d="M28.35 44.89C21.19 44.06 13.98 40.35 8.22 34.53C7.00 33.30 6.00 32.19 6.00 32.08C6.00 31.61 10.57 27.28 12.84 25.59C15.75 23.44 20.57 21.03 23.69 20.18C28.96 18.74 35.04 18.74 40.31 20.18C43.43 21.03 48.26 23.44 51.14 25.58C53.41 27.28 58.00 31.62 58.00 32.08C58.00 32.19 57.01 33.29 55.80 34.52C49.95 40.46 42.84 44.06 35.21 44.92C32.12 45.26 31.57 45.26 28.35 44.89Z"
        fill="#ffffff"
      />
      {/* 瞳孔＝橘色方塊 */}
      <rect x="24" y="24" width="16" height="16" rx="3" fill="#fd5108" />
    </svg>
  );
}

// 通用線條圖示（16px、currentColor）。
type IconProps = { size?: number } & SVGProps<SVGSVGElement>;

function base(size: number, props: SVGProps<SVGSVGElement>) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...props,
  };
}

/** 開啟檔案（匯入 / 上傳）。 */
export function IconOpen({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12 3v10" />
      <path d="M8 7l4-4 4 4" />
      <path d="M4 14v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

/** 建立快照（相機）。 */
export function IconSnapshot({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 8a1 1 0 0 1 1-1h2l1.2-1.8h5.6L20 7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8z" />
      <circle cx="12" cy="12.5" r="3.2" />
    </svg>
  );
}

/** 快照管理（清單面板）。 */
export function IconManage({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="4" y="4.5" width="16" height="6" rx="1.2" />
      <rect x="4" y="13.5" width="16" height="6" rx="1.2" />
    </svg>
  );
}

/** 複製到剪貼簿。 */
export function IconCopy({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

/** 重新命名（鉛筆）。 */
export function IconRename({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </svg>
  );
}

/** 刪除（垃圾桶）。 */
export function IconTrash({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </svg>
  );
}

/** 下載。 */
export function IconDownload({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12 3v11" />
      <path d="M8 10l4 4 4-4" />
      <path d="M4 20h16" />
    </svg>
  );
}

/** 清除篩選與排序（漏斗 + 斜線）。 */
export function IconClearFilter({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M3 5h18l-7 8v4l-4 2v-6L3 5z" />
      <path d="M4 20 20 4" />
    </svg>
  );
}

/** 更新紀錄（文件 + 條列）。 */
export function IconChangelog({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v4h4" />
      <path d="M8 12h8" />
      <path d="M8 16h5" />
    </svg>
  );
}

/** 欄位顯示/隱藏（表格欄）。 */
export function IconColumns({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="3" y="4" width="18" height="16" rx="1.3" />
      <path d="M9 4v16" />
      <path d="M15 4v16" />
    </svg>
  );
}

/** 行距（列高）：上下兩條橫線 + 中間上下箭頭。 */
export function IconRowHeight({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 5h16" />
      <path d="M4 19h16" />
      <path d="M12 8v8" />
      <path d="M9.5 10.5 12 8l2.5 2.5" />
      <path d="M9.5 13.5 12 16l2.5-2.5" />
    </svg>
  );
}

/** 預覽（眼睛，小）。 */
export function IconEye({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M2.5 12C5.5 7 18.5 7 21.5 12C18.5 17 5.5 17 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
