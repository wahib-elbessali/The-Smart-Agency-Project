import { registerMock } from '../registry'
import type { SetupStatus } from '@/api/types'

/* A believable half-set-up branch, so the checklist shows every state in mock
 * mode: done, to do, and one step the AI service could not be asked about. */
const status: SetupStatus = {
  items: [
    {
      key: 'hours',
      group: 'Foundation',
      label: 'Opening hours set',
      why: 'Used to work out how busy each counter is.',
      status: 'done',
      detail: 'Set',
      link: '/agencies',
    },
    {
      key: 'devices',
      group: 'Foundation',
      label: 'IoT devices registered',
      why: 'Sensors, door readers and the ticket kiosk each need a registered device and key.',
      status: 'done',
      detail: '2 devices',
      link: '/devices',
    },
    {
      key: 'cameras',
      group: 'Foundation',
      label: 'Cameras added',
      why: 'Every AI feature starts from a camera.',
      status: 'done',
      detail: '2 cameras',
      link: '/cameras',
    },
    {
      key: 'calibration',
      group: 'Vision',
      label: 'A camera calibrated and aligned',
      why: 'Needed before people can be placed on the floor plan.',
      status: 'unknown',
      detail: 'Could not check right now - the AI service did not answer.',
      link: '/calibration',
    },
    {
      key: 'services',
      group: 'Queue',
      label: 'A service is defined',
      why: 'A ticket is always for a service.',
      status: 'done',
      detail: '3 active services',
      link: '/services',
    },
    {
      key: 'ticket_layout',
      group: 'Queue',
      label: 'Ticket layout customised',
      why: 'Until then every ticket prints the generic default.',
      status: 'todo',
      detail: 'Still the generic default',
      link: '/ticket-template',
    },
    {
      key: 'thresholds',
      group: 'Safety',
      label: 'Sensor thresholds set',
      why: 'Without them a reading never raises an alert.',
      status: 'todo',
      detail: '0 active thresholds',
      link: '/devices',
    },
  ],
  done: 4,
  total: 7,
  complete: false,
}

registerMock<SetupStatus>('GET /api/agencies/{id}/setup-status', {
  normal: () => status,
  empty: () => status,
  large: () => status,
})
