from datetime import datetime, timedelta

# qualification enum
class Qualification:
    shooter = 0
    sergeant = 1
    officer = 2
    medic = 3
    driver = 4
    negev = 5
    mag = 6
    sharpshooter = 7
    sniper = 8
    commander = 9
    NUM_QUALIFICATION = 10

    
class Schedule:
    def __init__(self) -> None:
        self.schedule = {}

    def put(self, start, end, item):
        assert self.can_put(start, end)
        self.schedule[(start,end)] = item

    def remove(self, item):
        # find item and delete it
        for k,v in self.schedule.items():
            if v == item:
                del self.schedule[k]
                return True
        return False

    def can_put(self, start, end):
        for s,e in self.schedule.keys():
            if (start >= s and start < e) or (end > s and end <= e):
                return False
        return True



class Soldier:
    def __init__(self,name, age, qualifications:list) -> None:
        self.name = name
        self.age = age
        self.qualifications = qualifications
        self.lastAssignments = []

    def add_assignment(self, shift):
        # verify soldier is available
        if self.lastAssignments:
            assert self.lastAssignments[-1].end <= shift.start

        self.lastAssignments.append(shift)

    def get_assignment_score(self, assignment):
        '''
            returns score for specific assignemt, a higer score means higher match
        '''
        if len(self.lastAssignments) == 0:
            return float('inf')
        if assignment.start <= self.lastAssignments[-1].end:
            return float('-inf')
        # returns the time passed from last assignment to the new assignment, higher time means higher match
        return (assignment.start - self.lastAssignments[-1].end)


class Task:
    def __init__(self, name, description, duration, requirements) -> None:
        self.name=name
        self.description = description
        self.duration = duration
        self.requirements = requirements

class Shift:
    def __init__(self, task, start, end) -> None:
        self.task = task
        self.soldiers = [None] * len(task.requirements)
        self.start = start
        self.end = end

    def populate(self, soldiers) -> None:
        # verify assigment validity
        assert len(soldiers) == len(self.task.requirements)
        for req,soldier in zip(self.task.requirements, soldiers):
            assert req in soldier.qualifications

        # populate shift
        for i, soldier in enumerate(soldiers):
            self.assign(i,soldier)

    def assign(self, index, soldier):
        # verify assigment validity
        assert index < len(self.soldiers)
        assert self.task.requirements[index] in soldier.qualifications

        # assign the soldier
        self.soldiers[index] = soldier
        soldier.add_assignment(self)

    def __repr__(self):
        return f"<task {self.task.name} from {self.start} to {self.end}>"
    
class Schedule:
    def __init__(self) -> None:
        self._dict = {}

    def __getitem__(self, date: datetime):
        for key, value in self._dict.items():
            start_date, end_date = key
            if date >= start_date and date < end_date:
                return value
        raise ValueError(f"Key {key} not found")

    def __setitem__(self, date_range: tuple, value):
        self._dict[date_range] = value

class ShiftSchedule:
    def __init__(self, tasks:list, soldiers:list, start:datetime, end:datetime) -> None:
        self.tasks = tasks
        self.soldiers = soldiers
        self.start = start
        self.end = end
        self.soldiers_schedule = {Soldier:Schedule() for Soldier in soldiers}

    def create_shifts(self):
        # create empty shifts ordered by start time
        num_shifts_per_task = {task:int((self.end-self.start)/task.duration) for task in self.tasks}
        shifts = [Shift(task,[],self.start + (task.duration * i), self.start + ((task.duration * (i+1)))) for task in self.tasks for i in range(num_shifts_per_task[task])]
        shifts = sorted(shifts, key=lambda task:task.start)
        

        # populate shifts in shift by shift order
        for shift in shifts:
            shiftRequirements = shift.task.requirements
            for index, req in enumerate(shiftRequirements):
                qualified = [s for s in self.soldiers if req in s.qualifications]
                best_option = min(qualified, key = lambda s: s.get_assignment_score(shift))
                shift.assign(index, best_option)
        return shifts



if __name__ == '__main__':
    # create dummy soldiers
    s1 = Soldier('Tzahi', 25, [Qualification.shooter, Qualification.sergeant])
    s2 = Soldier('Yossi', 30, [Qualification.shooter, Qualification.sergeant])
    s4 = Soldier('David', 22, [Qualification.shooter, Qualification.medic])
    s3 = Soldier('Moshe', 20, [Qualification.shooter, Qualification.driver])
    s5 = Soldier('Yakov', 27, [Qualification.shooter, Qualification.driver])
    s6 = Soldier('Yehuda', 25, [Qualification.shooter, ])
    s7 = Soldier('Yosef', 25, [Qualification.shooter])
    s8 = Soldier('Yitzhak', 25, [Qualification.shooter])
    s9 = Soldier('Avraham', 25, [Qualification.shooter])
    s10 = Soldier('Yaakov', 25, [Qualification.shooter])
    s12 = Soldier('Levi', 25, [Qualification.shooter])
    s13 = Soldier('Shimon', 25, [Qualification.shooter])
    s14 = Soldier('Reuven', 25, [Qualification.shooter])
    s15 = Soldier('Dan', 25, [Qualification.shooter])
    s16 = Soldier('Naftali', 25, [Qualification.shooter])
    s17 = Soldier('Gad', 25, [Qualification.shooter])
    s18 = Soldier('Asher', 25, [Qualification.shooter])
    s19 = Soldier('Issachar', 25, [Qualification.shooter])
    s20 = Soldier('Zevulun', 25, [Qualification.shooter])
    s21 = Soldier('Aharon', 25, [Qualification.shooter])
    s22 = Soldier('Menashe', 25, [Qualification.shooter])
    s23 = Soldier('Ephraim', 25, [Qualification.shooter])
    s24 = Soldier('Benjamin', 25, [Qualification.shooter])
    s25 = Soldier('Shaul', 25, [Qualification.shooter])
    s26 = Soldier('Yair', 25, [Qualification.shooter])
    s27 = Soldier('Yehonatan', 25, [Qualification.shooter])
    s28 = Soldier('Shmuel', 25, [Qualification.shooter])
    s29 = Soldier('Ron', 25, [Qualification.shooter])
    s30 = Soldier('Yoni', 25, [Qualification.shooter])
    s31 = Soldier('Yael', 25, [Qualification.shooter])
    s32 = Soldier('Rivka', 25, [Qualification.shooter])
    s33 = Soldier('Rachel', 25, [Qualification.shooter])
    s34 = Soldier('Leah', 25, [Qualification.shooter])

    # create dummy tasks
    t1 = Task('gate', 'task1 description', timedelta(hours=4), [Qualification.shooter])
    t2 = Task('eastern gate', 'task2 description', timedelta(hours=4), [Qualification.shooter])
    t3 = Task('patrol', 'task3 description', timedelta(hours=8), [Qualification.shooter, Qualification.shooter, Qualification.driver, Qualification.sergeant])



    # create dummy shifts
    schedule = ShiftSchedule([t1,t2,t3], [s1,s2,s3,s4,s5,s6,s7,s8,s9], datetime(2021, 1, 1), datetime(2021, 1, 2))
    schedule.createShifts()