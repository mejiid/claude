import { ulid } from 'ulid'

export function generateGlobalId(): string {
  return ulid()
}