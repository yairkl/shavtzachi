from datetime import datetime, timedelta, time
from collections import defaultdict
import uuid

# Helper to convert col number (0-indexed) to letter
def col_letter(col):
    letter = ""
    col += 1
    while col > 0:
        col, remainder = divmod(col - 1, 26)
        letter = chr(65 + remainder) + letter
    return letter

def build_schedule_requests(sheet_id, assignments, start_date, end_date):
    """
    Builds a Timeline Layout:
    Y-axis (Col A, B): Date and Time (1 hour steps)
    X-axis (Row 0, 1): Posts and Roles
    Assignments are placed in cells and merged vertically.
    """
    if not assignments and not start_date:
        return []
        
    # Standardize range to full hours
    current_time = start_date.replace(minute=0, second=0, microsecond=0)
    limit_time = end_date.replace(minute=0, second=0, microsecond=0)
    if limit_time < end_date:
        limit_time += timedelta(hours=1)
        
    time_steps = []
    while current_time < limit_time:
        time_steps.append(current_time)
        current_time += timedelta(hours=1)
        
    time_to_row = {t: i + 2 for i, t in enumerate(time_steps)} # Data starts at row 2
    
    # 1. Map Columns
    # Posts -> List of (role_id, col_index)
    post_to_cols = defaultdict(list)
    
    # We need to know all roles for all posts
    unique_posts = sorted(list(set(a['post_name'] for a in assignments)))
    if not unique_posts:
        # If no assignments, we use start_date/end_date to just render a blank timeline?
        # In a real app we'd fetch active posts from DB.
        # For now, let's assume assignments are present or we skip.
        pass
        
    current_col = 2 # Col A (0) is Date, Col B (1) is Time
    post_col_ranges = {} # post_name -> (start_col, end_col)
    
    # Determine roles per post from assignments
    roles_per_post = defaultdict(set)
    for a in assignments:
        roles_per_post[a['post_name']].add(a['role_id'])
    
    for post_name in unique_posts:
        num_roles = max(roles_per_post[post_name]) + 1 if roles_per_post[post_name] else 1
        start_c = current_col
        for r in range(num_roles):
            post_to_cols[post_name].append((r, current_col))
            current_col += 1
        post_col_ranges[post_name] = (start_c, current_col)
        
    # 2. Build Grid Data
    requests = []
    row_data = [] # List of list of cell dicts
    merges = []
    
    def get_cell(val, is_header=False, bg_color=None):
        cell = {'userEnteredValue': {'stringValue': str(val) if val is not None else ""}}
        format = {
            'horizontalAlignment': 'CENTER',
            'verticalAlignment': 'MIDDLE',
            'borders': {
                'top': {'style': 'SOLID'}, 'bottom': {'style': 'SOLID'},
                'left': {'style': 'SOLID'}, 'right': {'style': 'SOLID'}
            }
        }
        if is_header:
            format['backgroundColor'] = {'red': 63/255, 'green': 81/255, 'blue': 181/255}
            format['textFormat'] = {'foregroundColor': {'red': 1, 'green': 1, 'blue': 1}, 'bold': True}
        if bg_color:
             format['backgroundColor'] = bg_color
        cell['userEnteredFormat'] = format
        return cell

    def set_cell(r, c, cell_dict):
        while len(row_data) <= r:
            row_data.append([])
        while len(row_data[r]) <= c:
            row_data[r].append({'userEnteredValue': {'stringValue': ""}})
        row_data[r][c] = cell_dict

    # --- Headers ---
    set_cell(0, 0, get_cell("Date", is_header=True))
    set_cell(0, 1, get_cell("Time", is_header=True))
    set_cell(1, 0, get_cell("", is_header=True))
    set_cell(1, 1, get_cell("", is_header=True))
    merges.append({'sheetId': sheet_id, 'startRowIndex': 0, 'endRowIndex': 2, 'startColumnIndex': 0, 'endColumnIndex': 1})
    merges.append({'sheetId': sheet_id, 'startRowIndex': 0, 'endRowIndex': 2, 'startColumnIndex': 1, 'endColumnIndex': 2})
    
    for post_name, (start_c, end_c) in post_col_ranges.items():
        set_cell(0, start_c, get_cell(post_name, is_header=True))
        # Merge Post Header
        if end_c - start_c > 1:
            for c in range(start_c + 1, end_c):
                set_cell(0, c, get_cell("", is_header=True))
            merges.append({'sheetId': sheet_id, 'startRowIndex': 0, 'endRowIndex': 1, 'startColumnIndex': start_c, 'endColumnIndex': end_c})
        else:
            merges.append({'sheetId': sheet_id, 'startRowIndex': 0, 'endRowIndex': 2, 'startColumnIndex': start_c, 'endColumnIndex': end_c})
            
        # Role Subheaders
        if end_c - start_c > 1:
            for r_idx, col in post_to_cols[post_name]:
                # Try to find a role name from assignments
                role_name = next((a.get('role_name') for a in assignments if a['post_name'] == post_name and a['role_id'] == r_idx), f"Role {r_idx+1}")
                set_cell(1, col, get_cell(role_name or f"Role {r_idx+1}", is_header=True))
                
    # --- Y-Axis ---
    for i, t in enumerate(time_steps):
        r = i + 2
        set_cell(r, 0, get_cell(t.strftime('%d/%m/%Y')))
        set_cell(r, 1, get_cell(t.strftime('%H:%M')))

    # --- Data & Merges ---
    div_colors = [
        {'red': 227/255, 'green': 242/255, 'blue': 253/255}, # E3F2FD
        {'red': 232/255, 'green': 245/255, 'blue': 233/255}, # E8F5E9
        {'red': 255/255, 'green': 243/255, 'blue': 224/255}, # FFF3E0
        {'red': 243/255, 'green': 229/255, 'blue': 245/255}, # F3E5F5
        {'red': 241/255, 'green': 248/255, 'blue': 233/255}, # F1F8E9
    ]
    
    for a in assignments:
        p_name = a['post_name']
        r_id = a['role_id']
        s_dt = a['start'].replace(minute=0, second=0, microsecond=0)
        e_dt = a['end'].replace(minute=0, second=0, microsecond=0)
        if e_dt == a['end'] and e_dt > s_dt:
             # If end is exactly on the hour, the last cell is e_dt - 1h
             pass
        elif e_dt < a['end']:
             # If end is e.g. 09:30, it occupies the 09:00 slot too
             e_dt += timedelta(hours=1)
        
        if s_dt not in time_to_row:
            if s_dt < time_steps[0] and e_dt > time_steps[0]:
                start_row = 2
            else:
                continue
        else:
            start_row = time_to_row[s_dt]
        # Calculate end row. Note: assignments can go beyond the sheet limit (limit_time)
        # but we only render what's in time_to_row.
        if e_dt in time_to_row:
            end_row = time_to_row[e_dt]
        else:
            end_row = len(time_steps) + 2
            
        # Find the column
        col = next((c for rid, c in post_to_cols[p_name] if rid == r_id), None)
        if col is not None:
            bg = None
            if a.get('division_id') is not None:
                bg = div_colors[a['division_id'] % len(div_colors)]
            
            # Fill all cells in the range with the soldier name to ensure 1-to-1 mapping
            for r in range(start_row, end_row):
                set_cell(r, col, get_cell(a['soldier_name'], bg_color=bg))
                
            if end_row > start_row + 1:
                merges.append({
                    'sheetId': sheet_id,
                    'startRowIndex': start_row,
                    'endRowIndex': end_row,
                    'startColumnIndex': col,
                    'endColumnIndex': col + 1
                })

    # Build requests
    req_rows = [{'values': r} for r in row_data]
    requests.append({
        'updateCells': {
            'range': {'sheetId': sheet_id, 'startRowIndex': 0, 'startColumnIndex': 0},
            'rows': req_rows,
            'fields': 'userEnteredValue,userEnteredFormat'
        }
    })
    
    for m in merges:
        requests.append({'mergeCells': {'range': m, 'mergeType': 'MERGE_ALL'}})
        
    return requests

def parse_grid(grid_rows, active_posts, base_date=None, merges=None):
    """
    Parses a Timeline Layout grid back into assignments.
    Uses merge metadata to accurately determine durations.
    """
    if not grid_rows or len(grid_rows) < 3:
        return []
        
    assignments = []
    
    # 0. Build a lookup for merges: (startRow, startCol) -> endRow
    merge_map = {}
    if merges:
        for m in merges:
            sr = m.get('startRowIndex', 0)
            sc = m.get('startColumnIndex', 0)
            er = m.get('endRowIndex', sr + 1)
            merge_map[(sr, sc)] = er

    def val(r, c):
        if r < len(grid_rows) and c < len(grid_rows[r]):
            return str(grid_rows[r][c]).strip()
        return ""

    # 1. Map Columns to Post/Role
    # Row 0 has Post Names
    # Row 1 has Role Names
    col_to_post = {} # col -> {"name": str, "role_id": int}
    
    # Date/Time are Col 0, 1
    c = 2
    while c < len(grid_rows[0]):
        p_name = val(0, c)
        if p_name:
            # How many roles?
            # Check Row 1. If empty and next col Row 0 is empty, it's a multi-col post
            role_id = 0
            col_to_post[c] = {"name": p_name, "role_id": role_id}
            
            # Look ahead for more roles of the same post
            lookahead = c + 1
            while lookahead < len(grid_rows[0]) and val(0, lookahead) == "" and val(1, lookahead) != "":
                role_id += 1
                col_to_post[lookahead] = {"name": p_name, "role_id": role_id}
                lookahead += 1
            c = lookahead
        else:
            c += 1
            
    # 2. Map Rows to Datetime
    row_to_dt = {}
    for r in range(2, len(grid_rows)):
        d_str = val(r, 0)
        t_str = val(r, 1)
        if d_str and t_str:
            try:
                # Try common formats
                if "/" in d_str:
                    dt = datetime.strptime(f"{d_str} {t_str}", "%d/%m/%Y %H:%M")
                else:
                    dt = datetime.strptime(f"{d_str} {t_str}", "%Y-%m-%d %H:%M")
                row_to_dt[r] = dt
            except:
                pass
                
    # 3. Parse Assignments
    for c, post_info in col_to_post.items():
        p_name = post_info["name"]
        role_id = post_info["role_id"]
        
        r = 2
        while r < len(grid_rows):
            soldier_name = val(r, c)
            if soldier_name and r in row_to_dt:
                start_dt = row_to_dt[r]
                
                # Determine end Row
                # Case 1: Merged cell
                if (r, c) in merge_map:
                    end_row = merge_map[(r, c)]
                    if end_row in row_to_dt:
                        end_dt = row_to_dt[end_row]
                    else:
                        # If end_row is beyond row_to_dt, extrapolate
                        last_r = max(row_to_dt.keys())
                        end_dt = row_to_dt[last_r] + timedelta(hours=(end_row - last_r))
                    curr_r = end_row
                else:
                    # Case 2: Scan for identical names in subsequent rows (fallback)
                    curr_r = r + 1
                    while curr_r < len(grid_rows) and val(curr_r, c) == soldier_name and curr_r in row_to_dt:
                         curr_r += 1
                    
                    if curr_r in row_to_dt:
                        end_dt = row_to_dt[curr_r]
                    else:
                        end_dt = row_to_dt[r] + timedelta(hours=1)
                
                assignments.append({
                    "post_name": p_name,
                    "start": start_dt,
                    "end": end_dt,
                    "role_id": role_id,
                    "soldier_name": soldier_name
                })
                r = curr_r
            else:
                r += 1
                
    return assignments
