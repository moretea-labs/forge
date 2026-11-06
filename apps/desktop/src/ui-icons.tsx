import {
  ArrowUp, BookOpen, Check, ChevronDown, ClipboardList, Copy, Ellipsis, FilePenLine,
  Folder, FolderGit2, GitBranch, GitCompareArrows, ListTodo, MessageSquare,
  MessagesSquare, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Server, Settings2, ShieldCheck, Square,
  SquarePen, Workflow, Search, X, type LucideIcon,
} from 'lucide-react';

/**
 * One icon family across the macOS client, including Agent controls.
 * Consistent 18px geometry, rounded 1.75px strokes, no font glyph placeholders.
 */
const icons = {
  'new-thread': SquarePen,
  'conversations': MessagesSquare,
  'conversation': MessageSquare,
  'draft': FilePenLine,
  'requirement': ClipboardList,
  'plan': ListTodo,
  'knowledge': BookOpen,
  'project': FolderGit2,
  'runtime': Server,
  'plus': Plus,
  'diff': GitCompareArrows,
  'more': Ellipsis,
  'folder': Folder,
  'branch': GitBranch,
  'work': Workflow,
  'settings': Settings2,
  'shield': ShieldCheck,
  'arrow': ArrowUp,
  'stop': Square,
  'chevron': ChevronDown,
  'book': BookOpen,
  'refresh': RefreshCw,
  'search': Search,
  'close': X,
  'copy': Copy,
  'check': Check,
  'sidebar-hide': PanelLeftClose,
  'sidebar-show': PanelLeftOpen,
} satisfies Record<string, LucideIcon>;

export type ForgeIconName = keyof typeof icons;

export function ForgeIcon({
  name, size = 18, className,
}: {
  name: ForgeIconName;
  size?: number;
  className?: string;
}) {
  const Icon = icons[name];
  return <Icon aria-hidden="true" focusable="false" size={size}
    strokeWidth={1.75} className={className} />;
}
