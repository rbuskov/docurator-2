export function slugify(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}
