import streamlit as st
from datetime import datetime, timedelta, time, date
import pandas as pd
import numpy as np
import logging
from schedule import generate_shifts, fill_shifts, solve_shift_assignment, build_schedule_df, visualize_schedule
from database import Post, Soldier, Shift, Assignment, engine
from sqlalchemy.orm import joinedload, Session
import plotly.express as px

# if 'db' not in st.session_state:
#     st.session_state['db'] = Session(engine)
# session = st.session_state['db']

logger = logging.getLogger(__name__)
logging.basicConfig(filename='app.log', level=logging.INFO)

# Initialize posts in session state
with Session(engine) as session:
    if 'posts' not in st.session_state:
        st.session_state['posts'] = session.query(Post).all()
    if 'workers' not in st.session_state:
        st.session_state['workers'] = session.query(Soldier).all()

# Define the dialog for creating a new post
@st.dialog("Create New Post")
def new_post():
    name = st.text_input("Post Name")
    shift_length = st.number_input("Shift Length (hours)", min_value=1, value=4)
    start_time = st.time_input("Start Time", value=datetime.min.time())
    end_time = st.time_input("End Time", value=datetime.min.time())
    end_time = (datetime.combine(date(2000,1,1), end_time) - timedelta(minutes=1)).time()
    requirements = st.multiselect("Requirements", ["soldier", "medic", "driver", "commander"], default=["soldier"])
    
    if st.button("Create"):
        with Session(engine) as session:
            # Check if post already exists
            existing_post = session.query(Post).filter_by(name=name).first()
            if existing_post:
                st.error(f"Post '{name}' already exists!")
                return

            # Create new post
            post = Post(name=name, shift_length=timedelta(hours=shift_length), start_time=start_time, end_time=end_time, requirements=requirements)
            session.add(post)
            session.commit()
        st.session_state.posts.append(post)
        st.success(f"Post '{name}' created successfully!")
        st.rerun()

# Define the dialog for adding a new worker
@st.dialog("Add New Worker")
def add_worker():
    worker_name = st.text_input(f"Enter name of worker")
    qualifications = st.multiselect("Qualifications", ["soldier", "medic", "driver", "commander"], default=["soldier"])
    if st.button("Add Worker"):
        with Session(engine) as session:
            existing_worker = session.query(Soldier).filter_by(name=worker_name).first()
            if existing_worker:
                st.error(f"Worker '{worker_name}' already exists!")
                return
            worker = Soldier(name=worker_name, qualifications=qualifications)
            session.add(worker)
            session.commit()
        st.session_state['workers'].append(worker)
        st.success(f"Worker '{worker_name}' added successfully!")
        st.rerun()

# Sidebar for dialog buttons
st.sidebar.header("Manage Posts and Workers")
if st.sidebar.button("Create New Post"):
    new_post()
if st.sidebar.button("Add New Worker"):
    add_worker()

# Main App Layout
st.title("Automatic Shift Scheduler")

# Display all posts and workers
col1, col2 = st.columns(2)
with col1.expander("Posts"):
    # Post.st_crud_tabs()
    def del_post(post):
        session.delete(post)
        session.commit()
        st.session_state['posts'].remove(post)
        st.success(f"Post '{post.name}' deleted successfully!")
        st.rerun()

    st.dataframe(pd.DataFrame([{
        'name': post.name,
        'shift_length': post.shift_length,
        'start_time': post.start_time,
        'end_time': post.end_time,
        'delete': st.button("Delete", key=post.name, on_click=lambda: del_post(post))
        } for post in st.session_state['posts']]), hide_index=True)

with col2.expander("Workers"):
    for worker in st.session_state['workers']:
        cont = st.container()
        c1, c2 = cont.columns(2)
        c1.write(worker)
        c2.button("Delete", key=f"worker {worker.id}")
        # delete icon button

if len(st.session_state['posts']) > 0 and len(st.session_state['workers']) > 0:
    # Generate schedules
    col1, col2 = st.columns(2)
    start_date = col1.date_input("Start Date", value=datetime.today())
    end_date = col2.date_input("End Date", value=datetime.today() + timedelta(days=1))
    if st.button("Generate Schedule"):
        with st.spinner("Generating..."):
            with Session(engine) as session:
                posts = session.query(Post).all()
                soldiers = session.query(Soldier).all()
                generate_shifts(posts, start_date, end_date, session=session)
                shifts = session.query(Shift).filter(Shift.start >= start_date, Shift.start < end_date).all()
                # fill_shifts(shifts, soldiers, session=session)
                # assignments = session.query(Assignment).filter(Assignment.shift_id.in_([shift.id for shift in shifts])).all()
                assignments = solve_shift_assignment(shifts, soldiers)
                fig = visualize_schedule(assignments)
                st.plotly_chart(fig, use_container_width=True)

    # st.dataframe(schedule, hide_index=True)
