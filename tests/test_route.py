import unittest
import numpy as np
from backend.traversability.mask import TraversabilityMask
from backend.traversability.route import plan_routes

class RouteTests(unittest.TestCase):
    def plan(self, floor):
        z=np.zeros_like(floor)
        return plan_routes(TraversabilityMask(floor.shape[1],floor.shape[0],floor,~floor,z,z,1))
    def test_open_floor_has_forward_route(self):
        r=self.plan(np.ones((240,320),dtype=bool))
        self.assertEqual(next(p for p in r['routes'] if p['direction']=='CENTER')['action'],'FORWARD')
    def test_islands_and_blocked_start_do_not_make_a_path(self):
        f=np.zeros((240,320),dtype=bool);f[100:180,:]=True
        self.assertEqual(self.plan(f)['status'],'blocked')
    def test_wall_cuts_off_floor_beyond_it(self):
        f=np.ones((240,320),dtype=bool);f[185:205,:]=False
        self.assertEqual(self.plan(f)['status'],'blocked')
    def test_paths_never_cross_obstacle(self):
        f=np.ones((240,320),dtype=bool);f[100:190,120:200]=False
        result=self.plan(f);self.assertTrue(result['routes'])
        for route in result['routes']:
            for x,y in route['points']: self.assertTrue(f[int(y*240),int(x*320)])
    def test_narrow_slit_not_a_corridor(self):
        f=np.zeros((240,320),dtype=bool);f[:,150:160]=True
        self.assertEqual(self.plan(f)['status'],'blocked')
