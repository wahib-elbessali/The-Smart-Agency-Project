import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { AppShell } from '@/components/AppShell'
import { RequireAuth } from '@/auth/RequireAuth'
import { useSession } from '@/auth/SessionContext'
import { landingPathFor } from '@/auth/landing'
import { SkeletonRows } from '@/components/ui/Skeleton'

/**
 * Screens are lazy so each becomes its own chunk. Six screens in one bundle
 * means opening the alerts view downloads the heatmap and every chart library
 * it will eventually pull in - on a wall display that is a slow first paint for
 * no reason.
 */
const EmployeePresence = lazy(() => import('@/screens/EmployeePresence'))
const Climate = lazy(() => import('@/screens/Climate'))
const VisitorQueue = lazy(() => import('@/screens/VisitorQueue'))
const Occupancy = lazy(() => import('@/screens/Occupancy'))
const Alerts = lazy(() => import('@/screens/Alerts'))
const Cameras = lazy(() => import('@/screens/Cameras'))
const Zones = lazy(() => import('@/screens/Zones'))
const Staffing = lazy(() => import('@/screens/Staffing'))
const Calibration = lazy(() => import('@/screens/Calibration'))
const Tracking = lazy(() => import('@/screens/Tracking'))
const FaceEnrollment = lazy(() => import('@/screens/FaceEnrollment'))
const Watchlist = lazy(() => import('@/screens/Watchlist'))
const CameraView = lazy(() => import('@/screens/CameraView'))
const ManualControls = lazy(() => import('@/screens/ManualControls'))
const Insights = lazy(() => import('@/screens/Insights'))
const Reports = lazy(() => import('@/screens/Reports'))
const Announcements = lazy(() => import('@/screens/Announcements'))
const AiSettings = lazy(() => import('@/screens/AiSettings'))
const Employees = lazy(() => import('@/screens/Employees'))
const Agencies = lazy(() => import('@/screens/Agencies'))
const AgencyDetail = lazy(() => import('@/screens/AgencyDetail'))
const Services = lazy(() => import('@/screens/Services'))
const TicketTemplate = lazy(() => import('@/screens/TicketTemplate'))
const Devices = lazy(() => import('@/screens/Devices'))
const Users = lazy(() => import('@/screens/Users'))
const Settings = lazy(() => import('@/screens/Settings'))
const Help = lazy(() => import('@/screens/Help'))
const Login = lazy(() => import('@/screens/Login'))

function RouteFallback() {
  return (
    <div className="max-w-2xl">
      <span className="sr-only" role="status" aria-live="polite">
        Loading screen
      </span>
      <SkeletonRows rows={3} />
    </div>
  )
}

/**
 * The one place a role becomes a starting screen.
 *
 * Login sends you to "/" rather than working the role out itself, so the map
 * has a single home and the sign-in screen keeps knowing nothing about roles.
 * It renders inside RequireAuth, so `user` is already resolved here.
 */
function Landing() {
  const { user } = useSession()
  return <Navigate to={landingPathFor(user?.role)} replace />
}

export function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Landing />} />
          {/* Every route below is registered for everyone and filtered by role
              in AppShell, which owns both the navigation and the URL guard
              (auth/access.ts). Routing stays a map of what exists; who may see
              it is one table rather than a condition repeated nine times. */}
          <Route path="presence" element={<EmployeePresence />} />
          <Route path="employees" element={<Employees />} />
          <Route path="agencies" element={<Agencies />} />
          <Route path="agencies/:id" element={<AgencyDetail />} />
          <Route path="services" element={<Services />} />
          <Route path="ticket-template" element={<TicketTemplate />} />
          <Route path="devices" element={<Devices />} />
          <Route path="users" element={<Users />} />
          <Route path="climate" element={<Climate />} />
          <Route path="visitors" element={<VisitorQueue />} />
          <Route path="occupancy" element={<Occupancy />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="cameras" element={<Cameras />} />
          <Route path="zones" element={<Zones />} />
          <Route path="staffing" element={<Staffing />} />
          <Route path="calibration" element={<Calibration />} />
          <Route path="tracking" element={<Tracking />} />
          <Route path="faces" element={<FaceEnrollment />} />
          <Route path="watchlist" element={<Watchlist />} />
          <Route path="cameras/:id" element={<CameraView />} />
          <Route path="controls" element={<ManualControls />} />
          <Route path="insights" element={<Insights />} />
          <Route path="reports" element={<Reports />} />
          <Route path="announcements" element={<Announcements />} />
          <Route path="ai-settings" element={<AiSettings />} />
          <Route path="settings" element={<Settings />} />
          <Route path="help" element={<Help />} />
          {/* An unknown path is not a reason to show someone a screen their
              role is refused from, so it resolves the same way "/" does. */}
          <Route path="*" element={<Landing />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
