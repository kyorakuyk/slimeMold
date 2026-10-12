/** Canonical cross-view selection contract for TaskGraph/Issue navigation. */
export interface TaskGraphSelection {
  projectId: string;
  taskGraphId: string;
  taskId: string;
  issueId: string;
}
