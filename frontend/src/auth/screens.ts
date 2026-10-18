import {
  Bell,
  BrainCircuit,
  Building2,
  Camera,
  ClipboardList,
  Cpu,
  Fan,
  Grid3x3,
  IdCard,
  KeyRound,
  Layers,
  type LucideIcon,
  Megaphone,
  MonitorCheck,
  Pentagon,
  Printer,
  Radar,
  Ruler,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
  Users,
} from 'lucide-react'
/**
 * Every screen in the shell, in the order the navigation shows them.
 *
 * Lives here rather than inside AppShell so the list and the rule that filters
 * it (access.ts) sit together, and neither has to be found from the other.
 *
 * Grouped into three sections (UX_AUDIT.md finding 6): `operations` is what
 * you do today (a task with a start and an end); `monitoring` is what you
 * watch (a live status, checked repeatedly, never "done"); `configuration` is
 * what you set up once and rarely return to. Every screen a role can open is
 * on the sidebar, grouped and not hidden: an earlier pass moved the set-up
 * screens into Settings and nobody could find them. A section with nothing the
 * signed-in role can reach is dropped.
 */
export type ScreenGroup = 'operations' | 'monitoring' | 'configuration'

export interface ScreenEntry {
  to: string
  label: string
  icon: LucideIcon
  group: ScreenGroup
  /** One line, shown in search results and on the Help screen. */
  description: string
}

export const SCREENS: readonly ScreenEntry[] = [
  // Operations
  {
    to: '/presence',
    label: 'Employee presence',
    icon: UserCheck,
    group: 'operations',
    description: 'Who badged in today, and when.',
  },
  {
    to: '/visitors',
    label: 'Visitor queue',
    icon: Users,
    group: 'operations',
    description: 'Tickets waiting, being served and done.',
  },
  {
    to: '/controls',
    label: 'Manual controls',
    icon: KeyRound,
    group: 'operations',
    description: 'Doors, locks and motors.',
  },
  {
    to: '/announcements',
    label: 'Announcements',
    icon: Megaphone,
    group: 'operations',
    description: 'Messages for the staff of a branch, or of every branch.',
  },
  // Monitoring
  {
    to: '/climate',
    label: 'Climate',
    icon: Fan,
    group: 'monitoring',
    description: 'Temperature, humidity and air quality.',
  },
  {
    to: '/occupancy',
    label: 'Occupancy',
    icon: Grid3x3,
    group: 'monitoring',
    description: 'How many people are in each zone.',
  },
  {
    to: '/staffing',
    label: 'Counter staffing',
    icon: MonitorCheck,
    group: 'monitoring',
    description: 'Which counters are manned right now.',
  },
  {
    to: '/tracking',
    label: 'Live map',
    icon: Radar,
    group: 'monitoring',
    description: 'Where people are on the floor, live.',
  },
  {
    to: '/alerts',
    label: 'Alerts',
    icon: Bell,
    group: 'monitoring',
    description: 'Live and recorded security alerts from the cameras.',
  },
  {
    to: '/insights',
    label: 'Insights',
    icon: BrainCircuit,
    group: 'monitoring',
    description: 'Customer satisfaction and waiting patterns.',
  },
  {
    to: '/reports',
    label: 'Reports',
    icon: ClipboardList,
    group: 'monitoring',
    description: 'End-of-month reports for one branch or all.',
  },
  // Configuration
  {
    to: '/agencies',
    label: 'Agencies',
    icon: Building2,
    group: 'configuration',
    description: 'Branches, and the way into one branch.',
  },
  {
    to: '/employees',
    label: 'Employees',
    icon: IdCard,
    group: 'configuration',
    description: 'Staff records and attendance history.',
  },
  {
    to: '/services',
    label: 'Services',
    icon: Layers,
    group: 'configuration',
    description: 'What visitors can take a ticket for.',
  },
  {
    to: '/ticket-template',
    label: 'Ticket layout',
    icon: Printer,
    group: 'configuration',
    description: 'How the printed ticket looks.',
  },
  {
    to: '/users',
    label: 'User accounts',
    icon: ShieldCheck,
    group: 'configuration',
    description: 'Logins, roles and branch access.',
  },
  {
    to: '/zones',
    label: 'Zones',
    icon: Pentagon,
    group: 'configuration',
    description: 'Draw the areas the cameras count.',
  },
  {
    to: '/calibration',
    label: 'Calibration',
    icon: Ruler,
    group: 'configuration',
    description: 'Map camera pixels to floor distances.',
  },
  {
    to: '/faces',
    label: 'Face enrollment',
    icon: ScanFace,
    group: 'configuration',
    description: 'Faces the system recognises as staff.',
  },
  {
    to: '/watchlist',
    label: 'Watchlist',
    icon: ShieldAlert,
    group: 'configuration',
    description: 'Who the wanted detector looks for, and its threshold.',
  },
  {
    to: '/cameras',
    label: 'Cameras',
    icon: Camera,
    group: 'configuration',
    description: 'Registered cameras and detector thresholds.',
  },
  {
    to: '/devices',
    label: 'IoT devices',
    icon: Cpu,
    group: 'configuration',
    description: 'Sensors, readers and their thresholds.',
  },
  {
    to: '/ai-settings',
    label: 'AI tuning',
    icon: SlidersHorizontal,
    group: 'configuration',
    description: 'Change AI service settings without a restart.',
  },
]

/** The sidebar sections, in order. SCREENS is already ordered within each. */
export const SCREEN_SECTIONS: readonly { group: ScreenGroup; title: string }[] = [
  { group: 'operations', title: 'Operations' },
  { group: 'monitoring', title: 'Monitoring' },
  { group: 'configuration', title: 'Configuration' },
]
