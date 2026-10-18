import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ScanFace } from 'lucide-react'
import {
  deleteEmployeeFace,
  enrollEmployeeFace,
  fetchEmployeeFace,
} from '@/api/endpoints/employeeFaces'
import { ApiError, describeApiError } from '@/api/errors'
import { Button } from '@/components/ui/Button'

/**
 * The employee's face for badge + face doors. Lives on the edit form because
 * it belongs to one employee; a photo uploads the moment it is picked, apart
 * from the form's own Save (2026-10-18 day test: a separate "Add photo"
 * button was missed, the form's Save clicked, and nothing enrolled). Several
 * photos (angles, lighting) make the door check more reliable.
 */
export function EmployeeFacePanel({ employeeId }: { employeeId: string }) {
  const queryClient = useQueryClient()
  const face = useQuery({
    queryKey: ['employeeFace', employeeId],
    queryFn: ({ signal }) => fetchEmployeeFace(employeeId, signal),
    retry: false,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['employeeFace', employeeId] })

  const enroll = useMutation({
    mutationFn: (photo: File) => enrollEmployeeFace(employeeId, photo),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => deleteEmployeeFace(employeeId),
    onSuccess: refresh,
  })

  const error = enroll.error ?? remove.error
  const message =
    error == null
      ? null
      : error instanceof ApiError && error.status === 422
        ? 'Use a photo with exactly one face, clearly visible.'
        : error instanceof ApiError
          ? describeApiError(error)
          : 'Could not save the photo.'

  return (
    <fieldset>
      <legend className="text-ink-2 flex items-center gap-2 text-sm font-medium">
        <ScanFace className="size-4" aria-hidden />
        Face for badge + face doors
      </legend>
      <p className="text-ink-3 mt-0.5 text-xs">
        {face.isPending
          ? 'Checking…'
          : face.error
            ? 'Could not reach the face service.'
            : face.data?.enrolled
              ? `Enrolled (${face.data.photos} ${face.data.photos === 1 ? 'photo' : 'photos'}). Add more for better recognition.`
              : 'Not enrolled - rooms that need a face will not open for this employee.'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept="image/*"
          aria-label="Add a face photo"
          className="text-ink-2 text-xs"
          disabled={enroll.isPending}
          onChange={(e) => {
            const photo = e.target.files?.[0]
            // Cleared so the same file can be picked again after an error.
            e.target.value = ''
            if (photo) enroll.mutate(photo)
          }}
        />
        {enroll.isPending && <span className="text-ink-3 text-xs">Uploading…</span>}
        {enroll.isSuccess && !enroll.isPending && (
          <span className="text-ok text-xs" role="status">
            Photo added.
          </span>
        )}
        {face.data?.enrolled && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove face
          </Button>
        )}
      </div>
      {message && (
        <p role="alert" className="text-warn mt-2 text-xs">
          {message}
        </p>
      )}
    </fieldset>
  )
}
