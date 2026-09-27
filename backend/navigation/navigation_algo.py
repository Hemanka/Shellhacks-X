"""A* pathfinding for the object-detection navigation grid."""

from heapq import heappop, heappush


Coordinate = tuple[int, int]

sample_grid = [
    [1,2,2,1,1,0,1,1],
    [1,1,2,1,2,2,1,1],
    [1,1,1,1,1,2,1,1],
    [1,0,0,1,1,1,1,1],
    [1,0,0,1,1,0,1,1],
    [1,0,0,1,0,0,1,1],
    [1,1,1,1,0,0,1,1],
    [0,-1,0,1,1,1,1,1],
]	


def a_star(grid: list[list[int]]) -> list[Coordinate] | None:
	"""Return the shortest path to the quickest reachable ``2`` cell."""
	if not grid or any(not row for row in grid):
		return None

	width = len(grid[0])
	if any(len(row) != width for row in grid):
		return None

	# Ensure the grid has one start state and at least one target.
	starts = [
		(row_index, column_index)
		for row_index, row in enumerate(grid)
		for column_index, value in enumerate(row)
		if value == -1
	]
	targets = [
		(row_index, column_index)
		for row_index, row in enumerate(grid)
		for column_index, value in enumerate(row)
		if value == 2
	]
	if len(starts) != 1 or not targets:
		return None

	start = starts[0]
	target_set = set(targets)

	def heuristic(position: Coordinate) -> int:
		return min(
			abs(position[0] - target[0]) + abs(position[1] - target[1])
			for target in targets
		)

	def neighbors(position: Coordinate):
		row, column = position
		for row_delta, column_delta in ((0, 1), (-1, 0), (0, -1), (1, 0)):
			next_row = row + row_delta
			next_column = column + column_delta
			if (
				0 <= next_row < len(grid)
				and 0 <= next_column < width
				and grid[next_row][next_column] != 0
			):
				yield next_row, next_column

	open_set: list[tuple[int, int, int, int, Coordinate]] = []
	heappush(open_set, (heuristic(start), 0, heuristic(start), 0, start))
	came_from: dict[Coordinate, Coordinate] = {}
	cost_so_far = {start: 0}
	sequence = 1

	while open_set:
		_, current_cost, _, _, current = heappop(open_set)
		if current_cost != cost_so_far[current]:
			continue
		if current in target_set:
			path = [current]
			while current in came_from:
				current = came_from[current]
				path.append(current)
			# Search positions are (row, column); expose them as (x, y).
			return [(column, row) for row, column in path[::-1]]

		for neighbor in neighbors(current):
			new_cost = cost_so_far[current] + 1
			if new_cost >= cost_so_far.get(neighbor, float("inf")):
				continue
			came_from[neighbor] = current
			cost_so_far[neighbor] = new_cost
			priority = new_cost + heuristic(neighbor)
			heappush(open_set, (priority, new_cost, heuristic(neighbor), sequence, neighbor))
			sequence += 1

	return None


def instruction(grid: list[list[int]]) -> list[str]:
	path = a_star(grid)
	instruction_set = []
	
	if not path or len(path) < 2:
		print("No path found")
		return instruction_set

	directions = []
	for (current_x, current_y), (next_x, next_y) in zip(path, path[1:]):
		directions.append((next_x - current_x, next_y - current_y))

	previous_direction = directions[0]
	instruction_set.append("Move Straight")

	for direction in directions[1:]:
		if direction == previous_direction:
			instruction_set.append("Move Straight")
		elif (previous_direction, direction) in {
			((0, -1), (1, 0)),
			((1, 0), (0, 1)),
			((0, 1), (-1, 0)),
			((-1, 0), (0, -1)),
		}:
			instruction_set.append("Turn Right and Move Straight")
		else:
			instruction_set.append("Turn Left and Move Straight")
		previous_direction = direction

	return instruction_set

set_of_instruction = instruction(sample_grid)
for i in set_of_instruction:
	print(i)