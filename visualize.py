from sqlalchemy.orm import Session
from sqlalchemy import create_engine
from database import Assignment, Soldier, Division, Post, Shift
import pandas as pd
import plotly.express as px

# # Create session
# engine = create_engine("sqlite:///data.db")  # Or your actual DB URI
# session = Session(engine)

# # Query Assignments and join necessary relationships
# assignments = session.query(
#     Assignment,
#     Assignment.role_id.label("role_id"),
#     Soldier.name.label("soldier_name"),
#     Soldier.division,
#     Post.name.label("post_name"),
#     Shift.start,
#     Shift.end
# ).join(Assignment.soldier) \
#  .join(Assignment.shift) \
#  .join(Shift.post) \
#  .all()

# # Convert to DataFrame
# data = [{
#     "soldier": a.soldier_name,
#     "division": a.division or "Unassigned",
#     "post": a.post_name,
#     "role_id": a.role_id,
#     "post_assign": f"{a.post_name} ({a.role_id + 1})",
#     "start": a.start,
#     "end": a.end
# } for a in assignments]

# df = pd.DataFrame(data)

# # Create separator rows
# min_time = df["start"].min()
# max_time = df["end"].max()
# separator_rows = []
# for post in df["post"].unique():
#     sep_label = f"🟫 {post.upper()}"  # optional emoji for clarity
#     separator_rows.append({
#         "soldier": sep_label,
#         "division": "separator",
#         "post": post,
#         "post_assign": post,
#         "start": min_time,
#         "end": max_time,
#         "role_id": -1
#     })

# # Append to original dataframe
# df = pd.concat([pd.DataFrame(separator_rows), df], ignore_index=True)

# # Set `post` as a categorical variable with ordered categories
# df["post"] = pd.Categorical(df["post"], categories=df["post"].unique(), ordered=True)
# # Set `post_assign` as a categorical variable with ordered categories
# df["post_assign"] = pd.Categorical(df["post_assign"], categories=df["post_assign"].unique()[::-1], ordered=True)
# # Set `division` as a categorical variable with ordered categories
# df["division"] = pd.Categorical(df["division"], categories=df["division"].unique(), ordered=True)

# # Sort post_assign manually by post name and role_id
# # df = df.sort_values(by=["post", "start", "role_id"])
# df = df.sort_values(by=["post", "role_id"])

# # Plotly timeline
# fig = px.timeline(
#     df,
#     x_start="start",
#     x_end="end",
#     y="post_assign",
#     color="division",
#     text="soldier",
#     title="Soldier Shift Schedule",
# )

# fig.update_yaxes(autorange="reversed", categoryorder="array", categoryarray=df["post_assign"].cat.categories.sort_values(ascending=True).tolist())

# fig.update_traces(textposition="inside", insidetextanchor="middle")
# fig.update_layout(
#     xaxis_title="Time",
#     yaxis_title="Post",
#     height=800,
#     )

# fig.show()


def visualize_schedule(assignments:list[Assignment]):
    # Convert to DataFrame
    data = [{
        "soldier": a.soldier.name,
        "division": a.soldier.division or "Unassigned",
        "post": a.post.name,
        "role_id": a.role_id,
        "post_assign": f"{a.post.name} ({a.role_id + 1})",
        "start": a.start,
        "end": a.end
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