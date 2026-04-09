from datetime import datetime, time, timedelta
import pandas as pd
import numpy as np
from database import Post, Soldier, Shift, Assignment, engine, Session
from typing import List, Optional
from ortools.sat.python import cp_model
import plotly.express as px
import itertools

def is_between(time, start, end):
    return start <= time <= end or start > end and (time >= start or time <= end)

def generate_schedule(posts, participants, start_date, end_date, time_step=timedelta(hours=1)):
    # for all posts, generate schedule from start_date to end_date with participants, no worker should work more than 1 shift at a time
    participants_last_shift = {participant: datetime.min for participant in participants}
    start_date = datetime.combine(start_date, time(6,0,0))
    end_date = datetime.combine(end_date, time(5,59,0))
    timesteps = pd.date_range(start_date, end_date, freq=time_step)
    schedule_df = pd.DataFrame(columns=[post.name for post in posts], index=timesteps)
    for t in schedule_df.index:
        for post in posts:
            duration = post.shift_length - timedelta(minutes=1)
            if not pd.isna(schedule_df.loc[t][post.name]):
                continue
            if is_between(t.time(), post.start_time, post.end_time):
                worker = min(participants_last_shift.items(), key=lambda x:x[1] + timedelta(seconds=np.random.randint(0,2)))[0]
                schedule_df.loc[t : t + duration, post.name] = worker.name
                participants_last_shift[worker] = t + duration
    return schedule_df    


# def generate_schedule_from_assignments(assignments):
#     """
#     Create a DataFrame with the assignment schedule ready for display.
#     :param assignments: List of Assignment objects
#     :return: DataFrame with columns ['Post', 'Start', 'End', 'Role', 'Soldier']
#     """
#     data = []
#     for assignment in assignments:
#         data.append({
#             'Post': assignment.shift.post.name,
#             'Start': assignment.shift.start,
#             'End': assignment.shift.end,
#             'Role': assignment.shift.post.requirements[assignment.role_id],
#             'Soldier': assignment.soldier.name
#         })
#     schedule_df = pd.DataFrame(data)
#     schedule_df.sort_values(by=['Post', 'Start'], inplace=True)
#     return schedule_df

def build_schedule_df(assignments):
    data = []
    for a in assignments:
        if a.shift and a.shift.post and a.soldier:
            data.append({
                "Assignment Label": f"{a.shift.post.name} - (Role {a.role_id + 1})",
                "Post": a.shift.post.name,
                "Start": a.shift.start,
                "End": a.shift.end,
                "Soldier": a.soldier.name,
                "Division": a.soldier.division,
                "Role ID": a.role_id,
            })
    schedule_df = pd.DataFrame(data)
    schedule_df.sort_values(by=['Start'], inplace=True)
    return schedule_df

def build_hourly_schedule_df(assignments, start=None, end=None):
    records = []
    min_time = None
    max_time = None

    for a in assignments:
        if not (a.shift and a.shift.post and a.soldier):
            continue

        shift_start = a.shift.start
        shift_end = a.shift.end
        min_time = min(min_time or shift_start, shift_start)
        max_time = max(max_time or shift_end, shift_end)

        # Generate time range for this assignment, 1-hour steps
        times = pd.date_range(start=shift_start, end=shift_end, freq='1h')
        column = f"{a.shift.post.name} - Role {a.role_id}"
        for t in times:
            records.append((t, column, a.soldier.name))

    # Fallback global time range if not explicitly passed
    if start is None:
        start = min_time
    if end is None:
        end = max_time

    # Create base time index (1 hour frequency)
    time_index = pd.date_range(start=start, end=end, freq='1h')
    df = pd.DataFrame(index=time_index)

    # Pivot records into a full schedule matrix
    for t, col, val in records:
        if col not in df.columns:
            df[col] = None
        df.at[t, col] = val
    # sort columns
    df = df.reindex(sorted(df.columns), axis=1)
    return df
    # Fallback global time range if not explicitly passed
    if start is None:
        start = min_time
    if end is None:
        end = max_time

    # Create base time index (1 hour frequency)
    time_index = pd.date_range(start=start, end=end, freq='1H')
    df = pd.DataFrame(index=time_index)

    # Pivot records into a full schedule matrix
    for t, col, val in records:
        if col not in df.columns:
            df[col] = None
        df.at[t, col] = val

    return df

def generate_shifts(posts, start_date, end_date, time_step=timedelta(hours=1), session=None):
    # for each post, generate all shifts from start_date to end_date
    shifts = []
    for post in posts:
        aligned_start = datetime.combine(start_date, post.start_time)
        aligned_end = datetime.combine(end_date, post.end_time)
        shifts_times = pd.date_range(aligned_start, aligned_end, freq=post.shift_length)
        for t in shifts_times:
            if is_between(t.time(), post.start_time, post.end_time):
                shift = Shift(post=post, start=t, end=t + post.shift_length)
                shifts.append(shift)
                if session:
                    # insert shift if it doesn't exist
                    if not session.query(Shift).filter(Shift.post_name == post.name, Shift.start == shift.start, Shift.end == shift.end).first():
                        session.add(shift)
    if session:
        session.commit()
    return shifts

def fill_shifts(shifts:List[Shift], soldiers:List[Soldier], session:Optional[Session] = None) -> List[Assignment]:
    """
    Given a list of shifts and a list of soldiers, fill the shifts with soldiers
    :param shifts: list of shifts
    :param soldiers: list of soldiers
    """
    
    model = cp_model.CpModel()
    # create variables for each shift and each soldier
    assignments_matrix = {}
    for soldier in soldiers:
        for shift in shifts:
            for role_id, role in enumerate(shift.post.requirements):
                assignments_matrix[(shift.id, soldier.id, role_id)] = model.NewBoolVar(f'assignment_{shift.id}_{soldier.id}_{role_id}')
    
    # create constraints for each shift
    # Existing Assignments should not be changed
    for shift in shifts:
        shifts_assignments = session.query(Assignment).filter(Assignment.shift_id == shift.id)
        for assignment in shifts_assignments:
            model.Add(assignments_matrix[(shift.id, assignment.soldier_id, assignment.role_id)] == 1)
            
    # each shift should be filled with the required number of soldiers
    for shift in shifts:
        for role_id, role in enumerate(shift.post.requirements):
            # each role in the shift should be filled with a soldier that has the required qualifications
            model.AddExactlyOne(assignments_matrix[(shift.id, soldier.id, role_id)] for soldier in soldiers if role in soldier.qualifications)
            model.Add(sum(assignments_matrix[(shift.id, soldier.id, role_id)] for soldier in soldiers if not role in soldier.qualifications) == 0)

    # Each soldier can only do one shift at a time
    overlapping_shifts_pairs = []
    for i, shift1 in enumerate(shifts):
        for j, shift2 in enumerate(shifts):
            if i <= j:
                continue
            if shift1.start < shift2.end + shift2.post.cooldown and shift2.start < shift1.end + shift1.post.cooldown:
                overlapping_shifts_pairs.append((shift1, shift2))
    
    for soldier in soldiers:
        for shift1, shift2 in overlapping_shifts_pairs:
            # if soldier is assigned to shift1, he can't be assigned to shift2
            model.Add(sum(assignments_matrix[(shift1.id, soldier.id, r)] for r in range(len(shift1.post.requirements)))
                      + sum(assignments_matrix[(shift2.id, soldier.id, r)] for r in range(len(shift2.post.requirements))) <= 1)
    
    # maximize rest time between shifts for each soldier
    # We'll maximize the minimum rest time between consecutive shifts for each soldier

    rest_time_vars = []
    for soldier in soldiers:
        # Collect all shifts for this soldier
        soldier_shifts = [shift for shift in shifts]
        n_roles = [len(shift.post.requirements) for shift in shifts]
        # For each pair of shifts, if both are assigned to this soldier, and shift2 starts after shift1 ends, compute rest time
        rest_vars = []
        for i, shift1 in enumerate(shifts):
            for j, shift2 in enumerate(shifts):
                if i == j:
                    continue
                # Only consider non-overlapping, consecutive shifts
                if shift2.start >= shift1.end:
                    for r1 in range(len(shift1.post.requirements)):
                        for r2 in range(len(shift2.post.requirements)):
                            # Both assignments must be active
                            assign1 = assignments_matrix[(shift1.id, soldier.id, r1)]
                            assign2 = assignments_matrix[(shift2.id, soldier.id, r2)]
                            # Rest time in hours
                            rest_hours = int((shift2.start - shift1.end).total_seconds() // 3600)
                            # Only count if both assignments are active
                            rest_var = model.NewIntVar(0, 100, f"rest_{soldier.id}_{shift1.id}_{shift2.id}_{r1}_{r2}")
                            # If both assignments are active, rest_var == rest_hours, else 0
                            model.Add(rest_var == rest_hours).OnlyEnforceIf([assign1, assign2])
                            model.Add(rest_var == 0).OnlyEnforceIf(~assign1).OnlyEnforceIf(assign2)
                            model.Add(rest_var == 0).OnlyEnforceIf(~assign2).OnlyEnforceIf(assign1)
                            model.Add(rest_var == 0).OnlyEnforceIf([~assign1, ~assign2])
                            rest_vars.append(rest_var)
        if rest_vars:
            min_rest = model.NewIntVar(0, 100, f"min_rest_{soldier.id}")
            model.AddMinEquality(min_rest, rest_vars)
            rest_time_vars.append(min_rest)
    if rest_time_vars:
        model.Maximize(sum(rest_time_vars))
    
    st_to_str = {
        0: "Search Limit Exceeded",
        1: "Model Invalid",
        2: "Feasible",
        3: "Unfeasible",
        4: "Optimal",
    }

    solver = cp_model.CpSolver()
    status = solver.Solve(model)
    
    if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
        print(f"Solution found with status: {st_to_str[status]}")
        # create assignments
        assignments = []
        for soldier in soldiers:
            for shift in shifts:
                for role_id, role in enumerate(shift.post.requirements):
                    if solver.Value(assignments_matrix[(shift.id, soldier.id, role_id)]) == 1:
                        assignment = Assignment(soldier_id=soldier.id, shift_id=shift.id, role_id=role_id)
                        assignments.append(assignment)
        if session:
            # filter assignments that already exists
            filtered_assignments = [a for a in assignments if not session.query(Assignment).filter(Assignment.soldier_id == a.soldier_id, Assignment.shift_id == a.shift_id, Assignment.role_id == a.role_id).first()]
            session.add_all(filtered_assignments)
            session.commit()
        return assignments
    else:
        raise ValueError(f"No solution found, {st_to_str[status]}")

def solve_shift_assignment(shifts:List[Shift], soldiers:List[Soldier]):
    model = cp_model.CpModel()
    maximize_expressions = []
    # Index shifts and soldiers by ID
    # shifts_by_id = {shift.id: shift for shift in shifts}
    # soldiers_by_id = {soldier.id: soldier for soldier in soldiers}

    # shift_ids = list(shifts_by_id.keys())
    # soldier_ids = list(soldiers_by_id.keys())

    # Role count per shift
    role_count = {shift.id: len(shift.post.requirements) for shift in shifts}
    qualifications = {soldier.id: set(soldier.qualifications) for soldier in soldiers}

    # Assignment variables: assignment[(shift_id, soldier_id, role_id)]
    assignment = {}
    for shift in shifts:
        for soldier in soldiers:
            for role_id in range(role_count[shift.id]):
                assignment[(shift.id, soldier.id, role_id)] = model.NewBoolVar(f"A_{shift.id}_{soldier.id}_{role_id}")

    # Constraint 1: All roles in each shift must be filled
    for shift in shifts:
        for role_id in range(role_count[shift.id]):
            model.Add(sum(
                assignment[(shift.id, soldier.id, role_id)] for soldier in soldiers
            ) == 1)

    # Constraint 2: A soldier can have at most one role in a shift
    for shift in shifts:
        for soldier in soldiers:
            model.Add(sum(
                assignment[(shift.id, soldier.id, r)] for r in range(role_count[shift.id])
            ) <= 1)

    # Constraint 3: Role qualification
    for shift in shifts:
        required_roles = shift.post.requirements
        for soldier in soldiers:
            soldier_qual = qualifications[soldier.id]
            for role_id, required_role in enumerate(required_roles):
                if required_role not in soldier_qual:
                    model.Add(assignment[(shift.id, soldier.id, role_id)] == 0)

    # Constraint 4: No overlapping shifts for same soldier
    for soldier in soldiers:
        for shift1, shift2 in itertools.combinations(shifts, 2):
            if not (shift1.end <= shift2.start or shift2.end <= shift1.start):
                for r1 in range(role_count[shift1.id]):
                    for r2 in range(role_count[shift2.id]):
                        model.Add(assignment[(shift1.id, soldier.id, r1)] + assignment[(shift2.id, soldier.id, r2)] <= 1)


    # Total assignments per soldier
    max_total_time = int((max(s.end for s in shifts) - min(s.start for s in shifts)).total_seconds() // 3600)
    total_assignments = {
        soldier.id: model.NewIntVar(0, max_total_time, f"total_assignments_{soldier.id}")
        for soldier in soldiers
    }

    for soldier in soldiers:
        model.Add(total_assignments[soldier.id] == sum(
            assignment[(shift.id, soldier.id, role_id)] * int((shift.end - shift.start).total_seconds() // 3600)
            for shift in shifts
            for role_id in range(role_count[shift.id])
        ))

    # Load balancing
    max_load = model.NewIntVar(0, max_total_time, "max_assignments")
    min_load = model.NewIntVar(0, max_total_time, "min_assignments")
    model.AddMaxEquality(max_load, list(total_assignments.values()))
    model.AddMinEquality(min_load, list(total_assignments.values()))

    # Objective: minimize load difference (fairness)
    load_diff = model.NewIntVar(0, len(shifts), "load_diff")
    model.Add(load_diff == max_load - min_load)
    maximize_expressions.append(-load_diff)

    # Objective: maximize rest time between shifts
    rest_time_vars = []
    for soldier in soldiers:
        for shift1, shift2 in itertools.combinations(shifts, 2):
            if shift1.end <= shift2.start:
                time_diff = int((shift2.start - shift1.end).total_seconds() // 3600)  # in Hours
                for r1 in range(role_count[shift1.id]):
                    for r2 in range(role_count[shift2.id]):
                        a1 = assignment[(shift1.id, soldier.id, r1)]
                        a2 = assignment[(shift2.id, soldier.id, r2)]
                        rest_var = model.NewIntVar(0, time_diff, f"rest_{shift1.id}_{shift2.id}_{soldier.id}")
                        # rest_var = time_diff * (a1 * a2)
                        model.AddMultiplicationEquality(rest_var, [a1, a2])
                        # Scale actual rest value (only valid when both shifts assigned to this soldier)
                        rest_time_vars.append(rest_var)

    # Define min_rest across all rest periods
    if rest_time_vars:
        min_rest = model.NewIntVar(0, max([int((s1.start - s2.end).total_seconds() // 3600) for s1, s2 in itertools.combinations(shifts, 2)]), "min_rest")
        sum_rest = model.NewIntVar(0, sum([int((s1.start - s2.end).total_seconds() // 3600) for s1, s2 in itertools.combinations(shifts, 2) if s1.start > s2.end]), "sum_rest")
        model.AddMinEquality(min_rest, rest_time_vars)
        model.Add(sum_rest == sum(rest_time_vars))
        # maximize_expressions.append(10 * min_rest)
        maximize_expressions.append(sum_rest)
    else:
        print("⚠ No possible rest intervals found (shifts may not be ordered or too close).")

    # Step 3: Set the objective to maximize the given expressions
    model.Maximize(sum(maximize_expressions))

    # Solve
    solver = cp_model.CpSolver()
    status = solver.Solve(model)

    st_to_str = {
        0: "Search Limit Exceeded",
        1: "Model Invalid",
        2: "Feasible",
        3: "Unfeasible",
        4: "Optimal",
    }

    if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
        assignments = []
        for shift in shifts:
            for soldier in soldiers:
                for role_id in range(role_count[shift.id]):
                    if solver.Value(assignment[(shift.id, soldier.id, role_id)]):
                        assignments.append(Assignment(soldier=soldier, shift=shift, role_id=role_id))
        return assignments
    else:
        print("No solution found.", st_to_str[status])
        return []

def validate_assignments(assignments:List[Assignment]):
    # TODO check overlapping assignments
    
    
    # TODO check minimum rest time between shifts
    pass

def schedule_to_posts_dict(schedule, posts):
    posts_dfs = {}
    for post in posts:
        post_df = schedule[[post.name]]
        post_df = post_df.resample(post.shift_length, offset=timedelta(hours=6)).first()
        # post_df['start_time'] = post_df.index
        post_df['end_time'] = post_df.index.shift(1)
        post_df.index.name = 'start_time'
        posts_dfs[post.name] = post_df[['end_time', post.name]].rename(columns={post.name: 'worker'})
    return posts_dfs

def visualize_schedule(assignments:list[Assignment]):
    # Convert to DataFrame
    data = [{
        "soldier": a.soldier.name,
        "division": a.soldier.division or "Unassigned",
        "post": a.shift.post.name,
        "role_id": a.role_id,
        "post_assign": f"{a.shift.post.name} ({a.role_id + 1})",
        "start": a.shift.start,
        "end": a.shift.end
    } for a in assignments]

    df = pd.DataFrame(data)

    # Create separator rows
    min_time = df["start"].min()
    max_time = df["end"].max()
    separator_rows = []
    for post in df["post"].unique():
        sep_label = f"🟫 {post.upper()}"  # optional emoji for clarity
        separator_rows.append({
            "soldier": sep_label,
            "division": "separator",
            "post": post,
            "post_assign": post,
            "start": min_time,
            "end": max_time,
            "role_id": -1
        })

    # Append to original dataframe
    df = pd.concat([pd.DataFrame(separator_rows), df], ignore_index=True)

    # Set `post` as a categorical variable with ordered categories
    df["post"] = pd.Categorical(df["post"], categories=df["post"].unique(), ordered=True)
    # Set `post_assign` as a categorical variable with ordered categories
    df["post_assign"] = pd.Categorical(df["post_assign"], categories=df["post_assign"].unique()[::-1], ordered=True)
    # Set `division` as a categorical variable with ordered categories
    df["division"] = pd.Categorical(df["division"], categories=df["division"].unique(), ordered=True)

    # Sort post_assign manually by post name and role_id
    # df = df.sort_values(by=["post", "start", "role_id"])
    df = df.sort_values(by=["post", "role_id"])

    # Plotly timeline
    fig = px.timeline(
        df,
        x_start="start",
        x_end="end",
        y="post_assign",
        color="division",
        text="soldier",
        title="Soldier Shift Schedule",
    )

    fig.update_yaxes(autorange="reversed", categoryorder="array", categoryarray=df["post_assign"].cat.categories.sort_values(ascending=True).tolist())

    fig.update_traces(textposition="inside", insidetextanchor="middle")
    fig.update_layout(
        xaxis_title="Time",
        yaxis_title="Post",
        )

    return fig

if __name__ == '__main__':
    with Session(engine) as session:
        soldiers = session.query(Soldier).all()
        posts = session.query(Post).all()
        generate_shifts(posts, datetime(2025,5,1), datetime(2025,5,3), session=session)
        shifts = session.query(Shift).all()
        assignments = fill_shifts(shifts, soldiers, session=session)
        print(f"Generated {len(assignments)} assignments.")
        schedule_df = build_schedule_df(assignments)
        hourly_schedule_df = build_hourly_schedule_df(assignments)
        print(schedule_df)
        hourly_schedule_df.to_csv('hourly_schedule.csv')
        
        # check that no name appear more than once per row
