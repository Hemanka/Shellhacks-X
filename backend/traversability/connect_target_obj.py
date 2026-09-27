from __future__ import annotations

from collections.abc import Sequence
from collections import deque


def connect_target_object(matrix: Sequence[Sequence[int]]) -> list[list[int]]:
	"""Add a centered start cell and flood-fill zero cells from target cells.

	The input matrix is not modified. Zero cells are changed to ``1`` while they
	are reachable from a ``2`` through 8-neighbor zero cells. Existing ``1``
	cells stop the flood fill. The center column of the last row is then marked
	``-1`` as the navigation start.
	"""
	if not matrix or not matrix[0]:
		raise ValueError("matrix must not be empty")

	width = len(matrix[0])
	if any(len(row) != width for row in matrix):
		raise ValueError("matrix rows must have the same length")

	connected = [list(row) for row in matrix]
	height = len(connected)
	queue = deque(
		(row_index, column_index)
		for row_index, row in enumerate(connected)
		for column_index, value in enumerate(row)
		if value == 2
	)

	while queue:
		row_index, column_index = queue.popleft()
		for row_delta in (-1, 0, 1):
			for column_delta in (-1, 0, 1):
				if row_delta == 0 and column_delta == 0:
					continue
				neighbor_row = row_index + row_delta
				neighbor_column = column_index + column_delta
				if (
					0 <= neighbor_row < height
					and 0 <= neighbor_column < width
					and connected[neighbor_row][neighbor_column] == 0
				):
					connected[neighbor_row][neighbor_column] = 1
					queue.append((neighbor_row, neighbor_column))

	connected[-1][width // 2] = -1
	return connected
