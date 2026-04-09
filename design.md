# System Design Document: Automated Personnel Scheduling System

## 1. System Overview
This document outlines the architecture and requirements for an automated, ILP-based (Integer Linear Programming) personnel scheduling system. The system is designed to handle complex shift assignments with variable durations, dynamic rest requirements, task-specific intensity weights, and strict role/skill-based constraints, all while optimizing for fairness and equitable workload distribution.

---

## 2. System Requirements

### 2.1. Functional Requirements
* **Personnel Management:** Ability to manage soldier profiles, including skills/certifications (e.g., Commander, Medic, Driver) and unavailability periods (e.g., leaves, medical exemptions).
* **Post & Slot Configuration:** Definition of posts with specific "slots". Each slot requires a specific skill, a defined shift duration (ranging from a few hours to multi-day operations), a task intensity weight, and a required rest period post-shift.
* **Automated Scheduling Engine:** An algorithmic solver that automatically generates shift assignments over a given time horizon, strictly adhering to all hard constraints.
* **Workload Fairness Tracking:** A dynamic tracking mechanism that calculates a "Fairness Debt/Credit" score based on the weighted sum of past shifts (duration $\times$ intensity) to ensure equitable distribution of difficult tasks.
* **Manual Override & Validation:** An interactive Gantt-style interface allowing commanders to manually drag-and-drop assignments. The system must provide real-time visual validation and block/warn against constraint violations (e.g., insufficient rest, missing skills).

### 2.2. Non-Functional Requirements
* **Scalability & Performance:** The scheduling algorithm must resolve a 7-to-14-day schedule for hundreds of personnel within minutes.
* **Granularity:** Time units must be granular (e.g., 1-hour intervals) to support overlapping variable-length shifts.

---

## 3. Mathematical Optimization Model (ILP)

The scheduling logic is formulated as a discrete-time Integer Linear Programming problem.

### 3.1. Sets and Indices
* $S$: Set of all soldiers, indexed by $i$.
* $P$: Set of all posts/tasks, indexed by $j$.
* $T$: Set of time intervals (e.g., hours) in the planning horizon, indexed by $t$.
* $K_{j,t}$: Set of required slots for post $j$ starting at time $t$, indexed by $k$.
* $C$: Set of available skills/roles, indexed by $c$.

### 3.2. Parameters (Inputs)
* $ReqSkill_{j,k} \in C$: The specific skill required for slot $k$ at post $j$.
* $HasSkill_{i,c} \in \{0, 1\}$: $1$ if soldier $i$ possesses skill $c$, $0$ otherwise.
* $Avail_{i,t} \in \{0, 1\}$: $1$ if soldier $i$ is available at time $t$, $0$ otherwise.
* $L_{j,k,t}$: The duration (in time units) of the shift for slot $k$ at post $j$ starting at time $t$.
* $RestReq_{j}$: The required rest duration (in time units) strictly enforced after completing a shift at post $j$.
* $Weight_{j}$: The intensity multiplier for post $j$ (e.g., 1.5 for kitchen duty, 0.5 for standby).
* $History_{i}$: The accumulated weighted workload score of soldier $i$ prior to the current scheduling run.

### 3.3. Decision Variables
The primary decision variable indicates the *start* of a shift:
$$x_{i,j,t,k} = \begin{cases} 1 & \text{if soldier } i \text{ starts shift at post } j, \text{ slot } k, \text{ at time } t \\ 0 & \text{otherwise} \end{cases}$$

### 3.4. Objective Function (Fairness Optimization)
To balance the workload, the algorithm minimizes the assignment of shifts to soldiers who already have a high historical workload score.
$$\min \sum_{i \in S} \sum_{j \in P} \sum_{t \in T} \sum_{k \in K_{j,t}} x_{i,j,t,k} \cdot History_{i}$$
*(Note: Upon shift completion, the database will update the history: $History_{i}^{new} = History_{i}^{old} + (L_{j,k,t} \cdot Weight_{j})$).*

### 3.5. Hard Constraints

**1. Demand Fulfillment:**
Every required slot must be filled by exactly one soldier at the specified start time.
$$\forall j \in P, \forall t \in T, \forall k \in K_{j,t}: \sum_{i \in S} x_{i,j,t,k} = 1$$

**2. Skill/Role Matching:**
A soldier can only be assigned to a slot if they possess the required skill.
$$\forall i \in S, \forall j \in P, \forall t \in T, \forall k \in K_{j,t}: x_{i,j,t,k} \leq HasSkill_{i, ReqSkill_{j,k}}$$

**3. Active Shift Non-Overlap (Concurrency Limit):**
A soldier cannot be assigned to a new shift if they are actively fulfilling an ongoing shift. For any given time $\tau$, the sum of all active shifts for soldier $i$ must be $\leq 1$.
$$\forall i \in S, \forall \tau \in T: \sum_{j \in P} \sum_{k \in K_{j,t}} \sum_{t = \tau - L_{j,k,t} + 1}^{\tau} x_{i,j,t,k} \leq 1$$

**4. Dynamic Rest Period Enforcement:**
If a soldier starts a shift at time $t$, they cannot start another shift until the current shift ends ($t + L_{j,k,t}$) plus the mandated rest period ($RestReq_{j}$).
$$\forall i, j, t, k: x_{i,j,t,k} + \sum_{j' \in P} \sum_{k'} \sum_{t' = t + 1}^{t + L_{j,k,t} + RestReq_{j} - 1} x_{i,j',t',k'} \leq 1$$

**5. Personal Availability:**
A soldier cannot be scheduled during a period where they are marked as unavailable (e.g., leave).
$$\forall i \in S, \forall j \in P, \forall t \in T, \forall k \in K_{j,t}: x_{i,j,t,k} \leq \prod_{\tau = t}^{t + L_{j,k,t} - 1} Avail_{i,\tau}$$

---

## 4. Database Schema (SQL)

The schema supports granular, slot-based, and weighted scheduling.

| Table Name | Key Columns | Description |
| :--- | :--- | :--- |
| **`Soldiers`** | `id`, `name`, `status`, `history_score` | Core personnel data. `history_score` tracks weighted effort. |
| **`Skills`** | `id`, `skill_name` | Dictionary of available roles (e.g., Medic, Driver). |
| **`Soldier_Skills`** | `soldier_id`, `skill_id` | M:N relation linking soldiers to their qualifications. |
| **`Unavailability`**| `id`, `soldier_id`, `start_datetime`, `end_datetime`, `reason`| Pre-approved leaves, medical profiles, or other blockers. |
| **`Posts`** | `id`, `name`, `default_rest_hours`, `intensity_weight` | Task definitions, including dynamic rest rules and task difficulty. |
| **`Post_Templates`**| `id`, `post_id`, `slot_index`, `req_skill_id`, `duration_hours`| Blueprint for a post. Defines slots, roles needed, and shift length. |
| **`Shifts`** | `id`, `start_datetime`, `end_datetime`, `post_template_id` | The actual time blocks generated for a given planning horizon. |
| **`Assignments`** | `id`, `shift_id`, `soldier_id`, `status` | The final pairing output generated by the algorithm or manual override. |

---

## 5. UI/UX Architecture

### 5.1. Dashboard & Analytics
* **Real-time Readiness:** Visual indicators showing the percentage of available personnel vs. required operational slots.
* **Fairness Ledger:** A leaderboard/bar chart displaying the `history_score` (Weighted Workload) of all personnel to assure commanders of algorithmic fairness.

### 5.2. Post & Template Configuration
* **Slot Builder:** An interface to define a post by adding rows (slots). For each slot, the user selects the required skill, sets the shift duration (e.g., 4 hours, 8 hours, 72 hours for multi-day deployments), and assigns the intensity weight and rest requirement.

### 5.3. The Scheduler Interface (Gantt View)
* **Dynamic Time Blocks:** Shifts are rendered horizontally on a continuous timeline. A 12-hour guard duty block visually spans three times the width of a 4-hour standby block.
* **Color Coding by Intensity:** High-intensity tasks (high weight) are rendered in distinct, bolder colors compared to low-intensity tasks.
* **Drag & Drop Constraint Validation:**
    * Commanders can drag a soldier's avatar to reassign them.
    * **Live Rules Engine:** If a commander drags a soldier onto a slot lacking the required rest, lacking the skill, or overlapping with another shift, the time block turns red, and a tooltip explicitly explains the violation (e.g., *"Cannot assign: Soldier requires 8 hours rest post-Kitchen Duty"*).
* **Publish & Commit:** Once the commander finalizes the schedule, clicking "Publish" writes the records to the `Assignments` table and incrementally updates the `history_score` for all scheduled soldiers.