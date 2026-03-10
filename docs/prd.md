# Product Requirements Document (PRD)

## 1. Product Vision & Value Proposition

**Core Problem Solved:** Eliminates the need for teams to switch context between separate chat apps (like Slack), task trackers (like Jira/Asana), and code repositories (GitHub). It centralizes communication and project tracking in one unified interface.

**Value Proposition:** Provides tight, side-by-side integration of real-time chat and multi-view project management, deeply linked with live GitHub status. The user experience must be exceptionally graceful, prioritizing a beautiful, smooth, and highly responsive UI over raw feature density.

**Successful Outcome:** A user can view their tasks in their preferred layout, instantly see if a blocking GitHub PR is merged, and ping a teammate about it without ever leaving the dashboard.

## 2. Core Workflows & User Stories

**Primary "Happy Path" Workflow:**
1. User logs in and connects their GitHub account.
2. User sees the main dashboard elegantly split into the Project Board (left 3/4) and Chat (right 1/4).
3. User creates a new task on the board in List or Kanban view, linking a GitHub issue.
4. User sees team members online in the chat window and uses a slash command (e.g., `/assign @colleague`) or sends a direct message to coordinate work.
5. As GitHub PRs are updated, the linked tasks on the board automatically reflect the new READ status in real-time.

**Edge Cases & Alternative Workflows:**
* A user wants to view the Gantt chart to adjust dependent task timelines when a GitHub PR is delayed.
* A user is offline or disconnected from chat but still needs to update board tasks.
* A slash command fails (e.g., trying to assign an invalid user or repository), and the system responds with a graceful, helpful error message.

**Entity State Machines:**
* **Tasks:** Fully customizable columns/states per project, allowing flexibility while maintaining sync with GitHub status where applicable.
* **GitHub Sync:** When a GitHub issue is closed, the linked task automatically moves to "Done" (or equivalent terminal state) via real-time webhooks.

## 3. UI/UX & Design Philosophy

**Design Goal:** A "graceful feeling product."
* **Fluid Layout:** The 3/4 (board) to 1/4 (chat) split should feel natural, with smooth, performant resizing or collapsing if needed.
* **Micro-Interactions:** Subtle animations for task movements, chat bubble appearances, and status updates to make the application feel alive and responsive.
* **Clutter-Free Interface:** Emphasize whitespace, clear typography, and a modern color palette to avoid the overwhelming density of traditional project management tools.

## 4. User Roles, Permissions, and Access

* **Admin/Workspace Owner:** Can manage billing, GitHub integrations, and all projects.
* **Member:** Can chat, create/edit tasks, and change views.
* **Guest/Viewer:** Can only read tasks and chat in specific assigned channels.

## 5. External Integrations (Business Context)

* **GitHub API (GraphQL preferred for efficiency):** For READ access to issues, pull requests, and real-time status updates (webhooks). Future iterations will support WRITE access.
* **WebSocket / Real-time Service (e.g., Supabase Realtime, Socket.io):** Powers the live chat, online presence indicators, and instant board syncing to ensure the UI always reflects the current state without manual refreshes.

## 6. Constraints & Technical Assumptions

* **Authentication:** Requires secure OAuth flow for both the application platform and the GitHub integration.
* **Performance:** Real-time sync and complex views (like the Gantt chart) must be optimized to prevent browser lag, ensuring the graceful UX is maintained.
* **Test Credentials:** Requires a dedicated GitHub fine-grained Personal Access Token with READ permissions for issues and PRs on a test repository to build the automated fixture generator. (Pending).
