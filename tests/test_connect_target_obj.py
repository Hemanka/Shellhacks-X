import unittest

from backend.traversability.connect_target_obj import connect_target_object


class ConnectTargetObjectTests(unittest.TestCase):
    def test_marks_center_start_and_connects_target_cluster(self) -> None:
        matrix = [
            [0, 0, 0, 0, 0],
            [0, 2, 2, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ]

        result = connect_target_object(matrix)

        self.assertEqual(result[-1][2], -1)
        self.assertEqual(result[1][1:3], [2, 2])
        self.assertEqual(result[0][0:4], [1, 1, 1, 1])
        self.assertEqual(result[2][0:4], [1, 1, 1, 1])
        self.assertEqual(matrix[-1][2], 0)

    def test_flood_fill_stops_at_existing_one_cells(self) -> None:
        matrix = [
            [1, 1, 1, 1, 1],
            [1, 2, 1, 0, 1],
            [1, 0, 1, 0, 1],
            [1, 1, 1, 1, 1],
        ]

        result = connect_target_object(matrix)

        self.assertEqual(result[1], [1, 2, 1, 0, 1])
        self.assertEqual(result[2], [1, 1, 1, 0, 1])
        self.assertEqual(result[3], [1, 1, -1, 1, 1])


if __name__ == "__main__":
    unittest.main()